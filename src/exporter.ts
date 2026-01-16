import type { TwitterClient, TweetData } from "@steipete/bird";
import type { ExporterConfig, ProcessedBookmark, ProcessedTweet } from "./types";
import {
  loadState,
  saveState,
  finishRun,
  appendError,
  bookmarkExists,
} from "./state";
import { expandThread } from "./thread";
import { processTweet, writeBookmarkMarkdown, writeArticleFromTweet } from "./markdown";
import { ensureAssetsDir } from "./media";

const PAGE_DELAY_MS = 2000; // 2 seconds between pages

interface ExportResult {
  exported: number;
  skipped: number;
  errors: number;
  hitPreviousExport: boolean;
  rateLimited: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Custom error for rate limiting - triggers immediate save & exit
class RateLimitError extends Error {
  constructor(context: string) {
    super(`Rate limited during ${context}`);
    this.name = "RateLimitError";
  }
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

// Wrap any client call - throws RateLimitError on rate limit
async function withRateLimitCheck<T>(
  fn: () => Promise<T>,
  context: string
): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      throw new RateLimitError(context);
    }
    throw error;
  }
}

// Recursively collect article links from a tweet and its quoted tweets,
// attributing each article link to its actual source tweet
function collectArticleLinksFromTweet(
  tweet: ProcessedTweet,
  result: { tweetId: string; articleIds: string[] }[]
): void {
  // Get this tweet's OWN article IDs (exclude ones from quoted tweet)
  const quotedArticleIds = tweet.processedQuotedTweet?.linkedArticleIds ?? [];
  const ownArticleIds = tweet.linkedArticleIds.filter(
    (id) => !quotedArticleIds.includes(id)
  );

  if (ownArticleIds.length > 0) {
    result.push({
      tweetId: tweet.id,
      articleIds: ownArticleIds,
    });
  }

  // Recurse into quoted tweet
  if (tweet.processedQuotedTweet) {
    collectArticleLinksFromTweet(tweet.processedQuotedTweet, result);
  }
}

// Collect all linked IDs from a processed bookmark
function collectLinkedIds(bookmark: ProcessedBookmark): {
  statusIds: string[];
  tweetsWithArticleLinks: { tweetId: string; articleIds: string[] }[];
} {
  const allTweets: ProcessedTweet[] = [
    bookmark.originalTweet,
    ...bookmark.threadTweets,
    ...bookmark.replies,
  ];

  const statusIds: string[] = [];
  const tweetsWithArticleLinks: { tweetId: string; articleIds: string[] }[] = [];

  for (const tweet of allTweets) {
    statusIds.push(...tweet.linkedStatusIds);

    // Collect article links, properly attributing to source tweet (including quoted tweets)
    collectArticleLinksFromTweet(tweet, tweetsWithArticleLinks);
  }

  return {
    statusIds: [...new Set(statusIds)],
    tweetsWithArticleLinks,
  };
}

// Fetch linked tweets and write any articles found
async function fetchLinkedArticles(
  client: TwitterClient,
  statusIds: string[],
  config: ExporterConfig
): Promise<void> {
  // Fetch status URLs (tweets that might have articles)
  for (const statusId of statusIds) {
    try {
      const result = await withRateLimitCheck(
        () => client.getTweet(statusId),
        `fetching linked tweet ${statusId}`
      );
      if (result.success && result.tweet && result.tweet.article) {
        const written = await writeArticleFromTweet(result.tweet, config.outputDir);
        if (written) {
          console.log(`    Found linked article: ${result.tweet.article.title}`);
        }
      }
    } catch (error) {
      // Re-throw rate limit errors to trigger save & exit
      if (error instanceof RateLimitError) throw error;

      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`    Could not fetch linked tweet ${statusId}: ${errorMessage}`);
      await appendError(config.outputDir, {
        tweetId: statusId,
        error: errorMessage,
        timestamp: new Date().toISOString(),
        context: `Fetching linked tweet for potential article`,
      });
    }
  }
}

// For tweets containing article links (x.com/i/article/...), re-fetch the tweet
// to get the article content. The article ID != tweet ID, but getTweet on the
// tweet containing the link will return the article content.
async function fetchArticlesFromTweetsWithArticleLinks(
  client: TwitterClient,
  tweetsWithArticleLinks: { tweetId: string; articleIds: string[] }[],
  config: ExporterConfig
): Promise<void> {
  for (const { tweetId, articleIds } of tweetsWithArticleLinks) {
    try {
      const result = await withRateLimitCheck(
        () => client.getTweet(tweetId),
        `fetching article tweet ${tweetId}`
      );
      if (result.success && result.tweet && result.tweet.article) {
        const written = await writeArticleFromTweet(result.tweet, config.outputDir);
        if (written) {
          console.log(`    Found article from tweet ${tweetId}: ${result.tweet.article.title}`);
        }
      } else {
        // Tweet fetched but no article - log for manual retrieval
        for (const articleId of articleIds) {
          console.warn(`    Article link in tweet ${tweetId} but no article content returned: x.com/i/article/${articleId}`);
          await appendError(config.outputDir, {
            tweetId: tweetId,
            error: `Tweet contains article link but getTweet didn't return article content. Article URL: https://x.com/i/article/${articleId}`,
            timestamp: new Date().toISOString(),
            context: `Article link that could not be automatically fetched`,
          });
        }
      }
    } catch (error) {
      // Re-throw rate limit errors to trigger save & exit
      if (error instanceof RateLimitError) throw error;

      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`    Could not fetch tweet ${tweetId} for article: ${errorMessage}`);
      for (const articleId of articleIds) {
        await appendError(config.outputDir, {
          tweetId: tweetId,
          error: `Failed to fetch tweet containing article link: ${errorMessage}. Article URL: https://x.com/i/article/${articleId}`,
          timestamp: new Date().toISOString(),
          context: `Article link that could not be automatically fetched`,
        });
      }
    }
  }
}

// Recursively expand quoted tweets to the specified depth
// quoteDepth 1 = tweet + its quoted tweet
// quoteDepth 2 = tweet + quoted tweet + quoted tweet's quoted tweet
// etc.
async function expandQuotedTweets(
  client: TwitterClient,
  tweet: TweetData,
  remainingDepth: number
): Promise<TweetData> {
  // If no more depth or no quoted tweet, return as-is
  if (remainingDepth <= 1 || !tweet.quotedTweet) {
    return tweet;
  }

  // We have a quoted tweet and want to go deeper
  // Fetch the quoted tweet to get its full data (including its own quotedTweet)
  try {
    const result = await withRateLimitCheck(
      () => client.getTweet(tweet.quotedTweet!.id),
      `expanding quoted tweet ${tweet.quotedTweet.id}`
    );
    if (result.success && result.tweet) {
      // Recursively expand the quoted tweet
      const expandedQuotedTweet = await expandQuotedTweets(
        client,
        result.tweet,
        remainingDepth - 1
      );
      return {
        ...tweet,
        quotedTweet: expandedQuotedTweet,
      };
    }
  } catch (error) {
    // Re-throw rate limit errors to trigger save & exit
    if (error instanceof RateLimitError) throw error;

    console.warn(`    Could not fetch quoted tweet ${tweet.quotedTweet.id}: ${error}`);
  }

  // If fetch failed, return original
  return tweet;
}

async function processBookmark(
  client: TwitterClient,
  tweet: TweetData,
  config: ExporterConfig
): Promise<ProcessedBookmark> {
  // Expand thread
  const { threadTweets, replies } = await withRateLimitCheck(
    () => expandThread(client, tweet, config.quoteDepth),
    `expanding thread ${tweet.id}`
  );

  // Expand quoted tweets for original and thread tweets (not replies)
  const expandedOriginal = await expandQuotedTweets(client, tweet, config.quoteDepth);
  const expandedThreadTweets = await Promise.all(
    threadTweets.map((t) => expandQuotedTweets(client, t, config.quoteDepth))
  );

  // Process all tweets (original, thread, replies)
  const processedOriginal = await processTweet(expandedOriginal, config.outputDir);

  const processedThread = await Promise.all(
    expandedThreadTweets.map((t) => processTweet(t, config.outputDir))
  );

  // Replies don't get quote depth expansion
  const processedReplies = await Promise.all(
    replies.map((t) => processTweet(t, config.outputDir))
  );

  return {
    originalTweet: processedOriginal,
    threadTweets: processedThread,
    replies: processedReplies,
  };
}

export async function exportBookmarks(
  client: TwitterClient,
  config: ExporterConfig
): Promise<ExportResult> {
  const result: ExportResult = {
    exported: 0,
    skipped: 0,
    errors: 0,
    hitPreviousExport: false,
    rateLimited: false,
  };

  // Ensure output directory exists
  await Bun.write(config.outputDir + "/.keep", "");
  await ensureAssetsDir(config.outputDir);

  // Load state
  let state = await loadState(config.outputDir);

  console.log("Starting bookmark export...");

  // Track if this is a fresh run (no pagination state)
  const isFreshRun = !state.nextCursor && !state.currentPageBookmarks;

  let pageNum = 0;

  while (true) {
    pageNum++;

    // Fetch bookmarks page
    let bookmarksPage: TweetData[];
    let nextCursor: string | undefined;

    // Check if we have cached page data to resume
    if (state.currentPageBookmarks && state.currentPageBookmarks.length > 0) {
      console.log(`Resuming from cached page with ${state.currentPageBookmarks.length} bookmarks...`);
      bookmarksPage = state.currentPageBookmarks;
      nextCursor = state.nextCursor;
    } else {
      console.log(
        `Fetching bookmarks page ${pageNum}${state.nextCursor ? " (resuming from cursor)" : ""}...`
      );

      try {
        // Use getAllBookmarks with maxPages:1 to properly support cursor pagination
        const bookmarksResult = await withRateLimitCheck(
          () =>
            client.getAllBookmarks({
              maxPages: 1,
              cursor: state.nextCursor,
            }),
          "fetching bookmarks"
        );

        if (!bookmarksResult.success) {
          throw new Error(
            bookmarksResult.error || "Failed to fetch bookmarks"
          );
        }

        bookmarksPage = bookmarksResult.tweets;
        nextCursor = bookmarksResult.nextCursor;

        console.log(
          `  Received ${bookmarksPage.length} bookmarks, nextCursor: ${nextCursor ? "yes" : "no"}`
        );

        if (bookmarksPage.length === 0) {
          if (nextCursor) {
            // Empty page but cursor exists - might be a gap, try continuing
            console.log("Empty page but cursor exists, continuing...");
            state.nextCursor = nextCursor;
            await saveState(config.outputDir, state);
            continue;
          }
          console.log("No more bookmarks to process (empty page, no cursor).");
          break;
        }

        console.log(
          `Got ${bookmarksPage.length} bookmarks${nextCursor ? ", more available" : ""}`
        );
      } catch (error) {
        // Rate limit during bookmark fetch - save state and exit
        if (error instanceof RateLimitError) {
          state.nextCursor = state.nextCursor; // Keep current cursor
          await saveState(config.outputDir, state);
          console.error(`\n${error.message}. State saved. Resume later to continue.`);
          result.rateLimited = true;
          return result;
        }
        console.error(`Failed to fetch bookmarks: ${error}`);
        throw error;
      }
    }

    // Process each bookmark
    for (let i = 0; i < bookmarksPage.length; i++) {
      const tweet = bookmarksPage[i];
      if (!tweet) continue; // TypeScript guard

      // Set first exported for this run (on the very first bookmark of a fresh run)
      if (isFreshRun && result.exported === 0 && result.skipped === 0 && i === 0) {
        state.currentRunFirstExported = tweet.id;
        await saveState(config.outputDir, state);
      }

      // Check if we've hit a previously exported bookmark
      if (state.previousFirstExported && tweet.id === state.previousFirstExported) {
        console.log(
          `Hit previously exported bookmark ${tweet.id}, stopping.`
        );
        result.hitPreviousExport = true;
        break;
      }

      // Check if already exported
      if (await bookmarkExists(config.outputDir, tweet)) {
        console.log(`Skipping already exported: ${tweet.id}`);
        result.skipped++;

        // On fresh run, if very first bookmark exists, we're done
        if (isFreshRun && i === 0 && pageNum === 1) {
          console.log("First bookmark already exported, nothing new to export.");
          result.hitPreviousExport = true;
          break;
        }
        continue;
      }

      // Process and export
      try {
        console.log(
          `Processing bookmark ${i + 1}/${bookmarksPage.length}: @${tweet.author.username} - ${tweet.text.slice(0, 50)}...`
        );

        const processed = await processBookmark(client, tweet, config);
        const filename = await writeBookmarkMarkdown(processed, config.outputDir);

        console.log(`  Exported: ${filename}`);

        // Fetch any linked articles
        const { statusIds, tweetsWithArticleLinks } = collectLinkedIds(processed);
        if (statusIds.length > 0) {
          await fetchLinkedArticles(client, statusIds, config);
        }
        if (tweetsWithArticleLinks.length > 0) {
          await fetchArticlesFromTweetsWithArticleLinks(client, tweetsWithArticleLinks, config);
        }

        result.exported++;

        // Update state - remove processed bookmark from current page
        state.currentPageBookmarks = bookmarksPage.slice(i + 1);
        await saveState(config.outputDir, state);
      } catch (error: unknown) {
        // Rate limit - save state (discard in-progress work) and exit immediately
        if (error instanceof RateLimitError) {
          state.currentPageBookmarks = bookmarksPage.slice(i); // Start from current tweet on resume
          state.nextCursor = nextCursor;
          await saveState(config.outputDir, state);

          console.error(`\n${error.message}. State saved. Resume later to continue.`);
          result.rateLimited = true;
          return result;
        }

        // Non-rate-limit error - log and continue
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(`  Error processing ${tweet.id}: ${errorMessage}`);
        await appendError(config.outputDir, {
          tweetId: tweet.id,
          error: errorMessage,
          timestamp: new Date().toISOString(),
          context: `Processing bookmark from @${tweet.author.username}`,
        });
        result.errors++;
      }
    }

    // Log page summary
    console.log(
      `\n--- Page ${pageNum} complete | Total: ${result.exported} exported, ${result.skipped} skipped, ${result.errors} errors ---\n`
    );

    if (result.hitPreviousExport) {
      break;
    }

    // Move to next page
    if (nextCursor) {
      state.nextCursor = nextCursor;
      state.currentPageBookmarks = undefined; // Clear - we'll fetch fresh
      await saveState(config.outputDir, state);

      console.log(`Waiting ${PAGE_DELAY_MS / 1000}s before next page...`);
      await sleep(PAGE_DELAY_MS);
    } else {
      // No more pages
      console.log("No more pages available.");
      break;
    }
  }

  // Finish run - update first exported tracking
  await finishRun(config.outputDir);

  return result;
}
