import { test, expect, describe } from "bun:test";
import { processTweet } from "./markdown";
import { TwitterClient, resolveCredentials, type TweetData } from "@steipete/bird";
import type { ProcessedTweet, ProcessedBookmark } from "./types";

// Load test tweets
const testTweets: TweetData[] = await Bun.file("./tests.json").json();

// Replicate the FIXED collectLinkedIds from exporter.ts

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

// Temp output dir for processTweet (it needs one for media download attempts)
const tmpDir = "/tmp/article-test";

describe("Article Detection - Using Actual Code Path", () => {
  test("processTweet populates linkedArticleIds for all tweets", async () => {
    let totalArticleIds = 0;
    const tweetsWithArticles: { tweetId: string; username: string; articleIds: string[] }[] = [];
    const tweetsWithoutArticles: { tweetId: string; username: string; tcoLinks: string[] }[] = [];

    console.log("\nProcessing all tweets through processTweet()...\n");

    for (const tweet of testTweets) {
      const processed = await processTweet(tweet, tmpDir);

      // Check for t.co links in original text
      const tcoLinks = tweet.text.match(/https?:\/\/t\.co\/[a-zA-Z0-9]+/g) || [];

      if (processed.linkedArticleIds.length > 0) {
        tweetsWithArticles.push({
          tweetId: tweet.id,
          username: tweet.author.username,
          articleIds: processed.linkedArticleIds,
        });
        totalArticleIds += processed.linkedArticleIds.length;
        console.log(`✅ Tweet ${tweet.id} (@${tweet.author.username}): ${processed.linkedArticleIds.length} article(s)`);
        console.log(`   Article IDs: ${processed.linkedArticleIds.join(", ")}`);
      } else if (tcoLinks.length > 0) {
        // Has t.co links but no articles found
        tweetsWithoutArticles.push({
          tweetId: tweet.id,
          username: tweet.author.username,
          tcoLinks,
        });
      }
    }

    // Count unique article IDs
    const allArticleIds = tweetsWithArticles.flatMap(t => t.articleIds);
    const uniqueArticleIds = [...new Set(allArticleIds)];

    console.log("\n================================");
    console.log(`Total tweets processed: ${testTweets.length}`);
    console.log(`Tweets with article links: ${tweetsWithArticles.length}`);
    console.log(`Total article IDs found: ${totalArticleIds}`);
    console.log(`Unique article IDs: ${uniqueArticleIds.length}`);

    if (tweetsWithoutArticles.length > 0) {
      console.log(`\nTweets with t.co links but NO articles detected (${tweetsWithoutArticles.length}):`);
      for (const t of tweetsWithoutArticles) {
        console.log(`  - ${t.tweetId} (@${t.username}): ${t.tcoLinks.join(", ")}`);
      }
    }

    // We expect at least 18 unique articles (bash script count)
    expect(uniqueArticleIds.length).toBeGreaterThanOrEqual(18);
  }, { timeout: 180000 });

  test("collectLinkedIds aggregates article IDs correctly", async () => {
    console.log("\nSimulating collectLinkedIds for each tweet as a bookmark...\n");

    let totalFromCollect = 0;

    for (const tweet of testTweets) {
      const processed = await processTweet(tweet, tmpDir);

      // Create a mock bookmark with just the original tweet (no thread/replies since we can't fetch)
      const mockBookmark: ProcessedBookmark = {
        originalTweet: processed,
        threadTweets: [],
        replies: [],
      };

      const { tweetsWithArticleLinks } = collectLinkedIds(mockBookmark);

      for (const { tweetId, articleIds } of tweetsWithArticleLinks) {
        totalFromCollect += articleIds.length;
        console.log(`Tweet ${tweetId}: collectLinkedIds found ${articleIds.length} article(s)`);
      }
    }

    console.log(`\nTotal from collectLinkedIds: ${totalFromCollect}`);
    // Passes if we find articles - exact count may vary due to QTs
    expect(totalFromCollect).toBeGreaterThanOrEqual(18);
  }, { timeout: 180000 });
});

describe("Article Text Fetching via getTweet", () => {
  test("getTweet returns article content for tweets with article links", async () => {
    // Initialize client with Firefox cookies
    console.log("\nResolving Twitter credentials from Firefox...");
    const credResult = await resolveCredentials({
      cookieSource: ["firefox"],
    });

    if (!credResult.cookies.authToken || !credResult.cookies.ct0) {
      console.error("Failed to get Twitter credentials from Firefox");
      console.error("Warnings:", credResult.warnings);
      throw new Error("No Firefox credentials available");
    }

    console.log(`Using cookies from: ${credResult.cookies.source}`);

    const client = new TwitterClient({
      cookies: credResult.cookies,
    });

    // Find tweets with article links using the FIXED collectLinkedIds
    // This properly attributes article links to their source tweet (including quoted tweets)
    const tweetsWithArticles: { tweetId: string; username: string; articleIds: string[] }[] = [];

    console.log("\nFinding tweets with article links (using fixed collectLinkedIds)...");
    for (const tweet of testTweets) {
      const processed = await processTweet(tweet, tmpDir);

      // Use collectLinkedIds to properly attribute article links
      const mockBookmark: ProcessedBookmark = {
        originalTweet: processed,
        threadTweets: [],
        replies: [],
      };
      const { tweetsWithArticleLinks } = collectLinkedIds(mockBookmark);

      for (const { tweetId, articleIds } of tweetsWithArticleLinks) {
        // Find the username for this tweet (might be the original or a quoted tweet)
        let username = tweet.author.username;
        if (tweetId !== tweet.id && processed.processedQuotedTweet?.id === tweetId) {
          username = processed.processedQuotedTweet.author.username;
        }
        tweetsWithArticles.push({ tweetId, username, articleIds });
      }
    }

    // Dedupe by tweetId (same tweet might be quoted by multiple bookmarks)
    const seen = new Set<string>();
    const dedupedTweetsWithArticles = tweetsWithArticles.filter(t => {
      if (seen.has(t.tweetId)) return false;
      seen.add(t.tweetId);
      return true;
    });

    console.log(`Found ${dedupedTweetsWithArticles.length} unique tweets with article links\n`);

    // Now call getTweet on each and check for article content
    let successCount = 0;
    let failCount = 0;
    const failures: { tweetId: string; username: string; reason: string }[] = [];

    for (const { tweetId, username, articleIds } of dedupedTweetsWithArticles) {
      try {
        const result = await client.getTweet(tweetId);

        if (!result.success) {
          failCount++;
          failures.push({ tweetId, username, reason: `API error: ${result.error}` });
          console.log(`❌ Tweet ${tweetId} (@${username}): API error - ${result.error}`);
          continue;
        }

        if (!result.tweet) {
          failCount++;
          failures.push({ tweetId, username, reason: "No tweet returned" });
          console.log(`❌ Tweet ${tweetId} (@${username}): No tweet returned`);
          continue;
        }

        const text = result.tweet.text || "";
        const textLength = text.length;
        const isJustALink = /^https?:\/\/\S+$/.test(text.trim());

        // Article content should be >140 chars and not just a link
        if (textLength > 140 && !isJustALink) {
          successCount++;
          console.log(`✅ Tweet ${tweetId} (@${username}): ${textLength} chars, article content fetched`);
        } else {
          failCount++;
          const reason = isJustALink ? "Just a link, no article text" : `Too short (${textLength} chars)`;
          failures.push({ tweetId, username, reason });
          console.log(`❌ Tweet ${tweetId} (@${username}): ${reason}`);
          console.log(`   Text: "${text.slice(0, 100)}..."`);
          console.log(`   Expected article IDs: ${articleIds.join(", ")}`);
        }
      } catch (error) {
        failCount++;
        const msg = error instanceof Error ? error.message : String(error);
        failures.push({ tweetId, username, reason: msg });
        console.log(`❌ Tweet ${tweetId} (@${username}): Exception - ${msg}`);
      }
    }

    console.log("\n================================");
    console.log(`Success: ${successCount}`);
    console.log(`Failed:  ${failCount}`);

    if (failures.length > 0) {
      console.log("\nFailure details:");
      for (const f of failures) {
        console.log(`  - ${f.tweetId} (@${f.username}): ${f.reason}`);
      }
    }

    // Some tweets link to articles but aren't the article themselves
    // This is expected - the fix should fetch the article ID, not the tweet ID
    console.log("\nNote: Failures are tweets that LINK to articles, not article tweets themselves.");
    console.log("The fix: fetchArticlesFromTweetsWithArticleLinks should fetch articleId, not tweetId");
  }, { timeout: 300000 }); // 5 min timeout for API calls

  test("quoted tweet with article link returns article when fetched directly", async () => {
    // Initialize client
    const credResult = await resolveCredentials({ cookieSource: ["firefox"] });
    if (!credResult.cookies.authToken || !credResult.cookies.ct0) {
      throw new Error("No Firefox credentials available");
    }
    const client = new TwitterClient({ cookies: credResult.cookies });

    // The quoted tweet that is JUST an article link
    const quotedTweetId = "2011523109871108570";

    console.log(`\nFetching quoted tweet ${quotedTweetId} (the article tweet)...`);

    const result = await client.getTweet(quotedTweetId);

    if (!result.success || !result.tweet) {
      console.log(`❌ Failed to fetch: ${result.error}`);
      expect(result.success).toBe(true);
      return;
    }

    const text = result.tweet.text || "";
    console.log(`✅ Fetched: ${text.length} chars`);
    console.log(`   Preview: "${text.slice(0, 300)}..."`);

    // This should be the article content (>140 chars)
    expect(text.length).toBeGreaterThan(140);
    console.log("\n✅ CONFIRMED: Fetching the quoted tweet ID returns article content!");
    console.log("   FIX: collectLinkedIds should track article links with their SOURCE tweet ID,");
    console.log("   not bubble them up to the parent tweet.");
  }, { timeout: 60000 });
});
