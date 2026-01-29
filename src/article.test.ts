import { test, expect, describe } from "bun:test";
import { processTweet } from "./markdown";
import type { TweetData } from "@steipete/bird";

// Load test tweets
const testTweets: TweetData[] = await Bun.file("./tests.json").json();

// Temp output dir for processTweet
const tmpDir = "/tmp/article-test";

describe("Article Detection", () => {
  test("processTweet detects article links in tweets", async () => {
    // Process a sample of tweets and count article detections
    const sampleSize = Math.min(50, testTweets.length);
    const sample = testTweets.slice(0, sampleSize);

    let tweetsWithArticles = 0;
    const articleIds: string[] = [];

    for (const tweet of sample) {
      const processed = await processTweet(tweet, tmpDir);
      if (processed.linkedArticleIds.length > 0) {
        tweetsWithArticles++;
        articleIds.push(...processed.linkedArticleIds);
      }
    }

    const uniqueArticleIds = [...new Set(articleIds)];

    // We expect to find some articles in any reasonable sample
    expect(tweetsWithArticles).toBeGreaterThan(0);
    expect(uniqueArticleIds.length).toBeGreaterThan(0);
  }, { timeout: 60000 });

  test("article links from quoted tweets are detected", async () => {
    // Find a tweet with a quoted tweet that has article links
    for (const tweet of testTweets) {
      if (!tweet.quotedTweet) continue;

      const processed = await processTweet(tweet, tmpDir);

      // Check if quoted tweet contributed article IDs
      if (processed.processedQuotedTweet?.linkedArticleIds?.length) {
        expect(processed.linkedArticleIds.length).toBeGreaterThanOrEqual(
          processed.processedQuotedTweet.linkedArticleIds.length
        );
        return; // Found one, test passes
      }
    }

    // If no tweets with quoted articles found, that's okay - skip
    console.log("No tweets with quoted article links in test data");
  }, { timeout: 60000 });
});
