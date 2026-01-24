import type { TwitterClient, TweetData } from "@steipete/bird";

export interface ThreadResult {
  threadTweets: TweetData[]; // Author's continuation chain (not including original)
  replies: TweetData[]; // Other users' top-level replies
}

// Check if an error is a rate limit error
function isRateLimitError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return (
    errorMessage.includes("rate") ||
    errorMessage.includes("429") ||
    errorMessage.includes("Too Many")
  );
}

export async function expandThread(
  client: TwitterClient,
  originalTweet: TweetData,
  includeReplies: boolean
): Promise<ThreadResult> {
  const threadTweets: TweetData[] = [];
  const potentialReplies: TweetData[] = [];
  const authorUsername = originalTweet.author.username.toLowerCase();

  let currentTweetId = originalTweet.id;
  let isFirstCall = true; // Only collect replies on first getThread call

  // Keep fetching while author continues the thread
  while (true) {
    try {
      const result = await client.getThread(currentTweetId);

      if (!result.success) {
        const errorMsg = result.error || "unknown error";
        // Check if this is a rate limit error - if so, throw to trigger save & exit
        if (errorMsg.includes("429") || errorMsg.includes("rate") || errorMsg.includes("Too Many")) {
          throw new Error(`Rate limit: ${errorMsg}`);
        }
        console.warn(`  getThread failed for ${currentTweetId}: ${errorMsg}`);
        break;
      }

      if (!result.tweets || result.tweets.length === 0) {
        // Normal - no replies or thread continuation found
        break;
      }

      // Find author's reply to current tweet
      let authorReply: TweetData | undefined;

      for (const tweet of result.tweets) {
        // Skip the original tweet itself (might be included in response)
        if (tweet.id === currentTweetId) continue;

        const isByAuthor = tweet.author.username.toLowerCase() === authorUsername;

        // Check if this is the author's direct reply to continue the thread
        const isThreadContinuation =
          isByAuthor && tweet.inReplyToStatusId === currentTweetId;

        if (isThreadContinuation) {
          authorReply = tweet;
        } else if (isFirstCall && !potentialReplies.some((r) => r.id === tweet.id)) {
          // On first call only, collect all other tweets as potential replies
          potentialReplies.push(tweet);
        }
      }

      // After first call, stop collecting replies
      isFirstCall = false;

      if (authorReply) {
        threadTweets.push(authorReply);
        currentTweetId = authorReply.id;
      } else {
        // No more author replies, thread chain ends
        break;
      }
    } catch (error) {
      // Re-throw rate limit errors to trigger save & exit
      if (isRateLimitError(error)) throw error;

      console.warn(`Error expanding thread from ${currentTweetId}: ${error}`);
      break;
    }
  }

  // If not including replies, return just the thread
  if (!includeReplies) {
    return { threadTweets, replies: [] };
  }

  // Filter replies: exclude any that are actually part of the thread
  // A tweet is part of the thread if:
  // 1. It's in threadTweets (by ID)
  // 2. It's by the author and is a reply to any thread tweet
  const threadTweetIds = new Set([originalTweet.id, ...threadTweets.map((t) => t.id)]);

  const replies = potentialReplies.filter((tweet) => {
    // Exclude if this tweet is in the thread
    if (threadTweetIds.has(tweet.id)) return false;

    // Exclude if this is the author replying to a thread tweet
    const isByAuthor = tweet.author.username.toLowerCase() === authorUsername;
    if (isByAuthor && tweet.inReplyToStatusId && threadTweetIds.has(tweet.inReplyToStatusId)) {
      return false;
    }

    return true;
  });

  return { threadTweets, replies };
}
