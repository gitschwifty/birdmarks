import type { TwitterClient, TweetData } from "@steipete/bird";
import type { ExporterConfig, ProcessedBookmark, ProcessedTweet } from "./types";
import {
  loadState,
  saveState,
  finishRun,
  appendError,
  bookmarkExists,
  bookmarkExistsById,
  findBookmarkPath,
  bookmarkHasReplies,
  bookmarkHasFrontmatter,
} from "./state";
import { expandThread } from "./thread";
import { processTweet, writeBookmarkMarkdown, writeArticleFromTweet, generateRepliesSection } from "./markdown";
import { ensureAssetsDir } from "./media";

const PAGE_DELAY_MS = 2000; // 2 seconds between pages

interface ExportResult {
  exported: number;
  skipped: number;
  errors: number;
  hitPreviousExport: boolean;
  rateLimited: boolean;
  backfilled?: number; // Number of bookmarks that had replies backfilled
  frontmatterAdded?: number; // Number of bookmarks that had frontmatter added/updated
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
    () => expandThread(client, tweet, config.includeReplies),
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

// Export a single tweet by ID (for testing or re-running errors)
export async function exportSingleTweet(
  client: TwitterClient,
  tweetId: string,
  config: ExporterConfig
): Promise<{ success: boolean; error?: string; filename?: string }> {
  // Ensure output directory exists
  await Bun.write(config.outputDir + "/.keep", "");
  await ensureAssetsDir(config.outputDir);

  console.log(`Fetching tweet ${tweetId}...`);

  // Fetch the tweet
  const tweetResult = await withRateLimitCheck(
    () => client.getTweet(tweetId),
    `fetching tweet ${tweetId}`
  );

  if (!tweetResult.success || !tweetResult.tweet) {
    return { success: false, error: tweetResult.error || "Tweet not found" };
  }

  const tweet = tweetResult.tweet;
  console.log(`Got tweet by @${tweet.author.username}: ${tweet.text.slice(0, 50)}...`);

  // Process like a bookmark
  console.log("Processing tweet (expanding thread, fetching media, etc.)...");
  const processed = await processBookmark(client, tweet, config);

  // Write markdown
  const filename = await writeBookmarkMarkdown(processed, config.outputDir, config.useDateFolders);
  console.log(`Exported: ${filename}`);

  // Fetch any linked articles
  const { statusIds, tweetsWithArticleLinks } = collectLinkedIds(processed);
  if (statusIds.length > 0) {
    console.log(`Fetching ${statusIds.length} linked tweets for potential articles...`);
    await fetchLinkedArticles(client, statusIds, config);
  }
  if (tweetsWithArticleLinks.length > 0) {
    console.log(`Fetching ${tweetsWithArticleLinks.length} tweets with article links...`);
    await fetchArticlesFromTweetsWithArticleLinks(client, tweetsWithArticleLinks, config);
  }

  return { success: true, filename };
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
  const hasResumeState = !!state.nextCursor || !!state.currentPageBookmarks;
  let pagesFetchedThisRun = 0;

  // === NEW BOOKMARKS PHASE ===
  // If fetchNewFirst is enabled and we have resume state, fetch new bookmarks from the top first
  if (config.fetchNewFirst && hasResumeState) {
    console.log("\n=== Fetching new bookmarks first ===\n");

    // The stopping point is the first tweet we exported when this run started
    // Fall back to previousFirstExported if currentRunFirstExported isn't set (old state)
    const newPhaseStopAt = state.currentRunFirstExported ?? state.previousFirstExported;
    if (newPhaseStopAt) {
      console.log(`Will stop when reaching: ${newPhaseStopAt}`);
    } else {
      console.log(`Warning: No stopping point found in state, will process until no new bookmarks`);
    }

    let newPageNum = 0;
    let newCursor: string | undefined = undefined;
    let newPhaseFirstExported: string | undefined;
    let pagesWithoutNewExports = 0;
    const MAX_PAGES_WITHOUT_NEW = 2; // Safety: stop after 2 pages with no new exports

    newBookmarksLoop: while (true) {
      newPageNum++;
      pagesFetchedThisRun++;

      // Check max pages limit
      if (config.maxPages && pagesFetchedThisRun >= config.maxPages) {
        console.log(`Reached max pages limit (${config.maxPages}) during new bookmarks phase.`);
        console.log("State preserved. Run again to continue.");
        return result;
      }

      console.log(`Fetching new bookmarks page ${newPageNum}...`);

      try {
        const bookmarksResult = await withRateLimitCheck(
          () => client.getAllBookmarks({ maxPages: 1, cursor: newCursor }),
          "fetching new bookmarks"
        );

        if (!bookmarksResult.success) {
          throw new Error(bookmarksResult.error || "Failed to fetch bookmarks");
        }

        const bookmarksPage = bookmarksResult.tweets;
        newCursor = bookmarksResult.nextCursor;

        if (bookmarksPage.length === 0) {
          console.log("No new bookmarks found.");
          break;
        }

        console.log(`Got ${bookmarksPage.length} bookmarks${newCursor ? ", more available" : ""}`);

        // Track exports this page for the safety counter
        const exportsBeforePage = result.exported;

        // Process bookmarks until we hit the stopping point
        for (let i = 0; i < bookmarksPage.length; i++) {
          const tweet = bookmarksPage[i];
          if (!tweet) continue;

          // Check if we've hit the stopping point (first exported from this run)
          if (newPhaseStopAt && tweet.id === newPhaseStopAt) {
            console.log(`Hit stopping point ${tweet.id}, new bookmarks phase complete.`);
            break newBookmarksLoop;
          }

          // Track first seen in new phase (for next run's stopping point)
          if (!newPhaseFirstExported) {
            newPhaseFirstExported = tweet.id;
          }

          // Check if already exported
          const alreadyExists = await bookmarkExistsById(config.outputDir, tweet.id, tweet.createdAt, config.useDateFolders);
          if (alreadyExists) {
            console.log(`Skipping existing bookmark ${tweet.id}`);
            result.skipped++;
            continue; // Skip but keep going - don't break!
          }

          console.log(
            `Processing new bookmark ${i + 1}/${bookmarksPage.length}: @${tweet.author.username} - ${tweet.text.slice(0, 50)}...`
          );

          try {
            // Use processBookmark which handles article re-fetching
            const processed = await processBookmark(client, tweet, config);

            const filename = await writeBookmarkMarkdown(processed, config.outputDir, config.useDateFolders);
            console.log(`  Exported (new): ${filename}`);
            result.exported++;

            // Fetch any linked articles
            const { statusIds, tweetsWithArticleLinks } = collectLinkedIds(processed);
            if (statusIds.length > 0) {
              await fetchLinkedArticles(client, statusIds, config);
            }
            if (tweetsWithArticleLinks.length > 0) {
              await fetchArticlesFromTweetsWithArticleLinks(client, tweetsWithArticleLinks, config);
            }
          } catch (error: unknown) {
            if (error instanceof RateLimitError) {
              console.error(`\n${error.message}. State preserved. Resume later to continue.`);
              result.rateLimited = true;
              return result;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`  Error processing ${tweet.id}: ${errorMessage}`);
            await appendError(config.outputDir, {
              tweetId: tweet.id,
              error: errorMessage,
              timestamp: new Date().toISOString(),
              context: `Processing new bookmark from @${tweet.author.username}`,
            });
            result.errors++;
          }
        }

        // Check if we exported anything this page
        const exportsThisPage = result.exported - exportsBeforePage;
        if (exportsThisPage > 0) {
          pagesWithoutNewExports = 0;
        } else {
          pagesWithoutNewExports++;
          if (pagesWithoutNewExports >= MAX_PAGES_WITHOUT_NEW) {
            console.log(`No new exports for ${MAX_PAGES_WITHOUT_NEW} pages, new bookmarks phase complete.`);
            break;
          }
        }

        if (!newCursor) {
          console.log("No more new bookmarks pages.");
          break;
        }

        await sleep(PAGE_DELAY_MS);
      } catch (error) {
        if (error instanceof RateLimitError) {
          console.error(`\n${error.message}. State preserved. Resume later to continue.`);
          result.rateLimited = true;
          return result;
        }
        throw error;
      }
    }

    // Update firstExported if we exported anything in new phase
    if (newPhaseFirstExported) {
      state.currentRunFirstExported = newPhaseFirstExported;
      await saveState(config.outputDir, state);
      console.log(`Updated anchor to: ${newPhaseFirstExported}`);
    }

    console.log(`\n=== New bookmarks phase complete (${result.exported} exported, ${result.skipped} skipped) ===`);
    console.log("=== Continuing from saved cursor ===\n");
  }

  // === MAIN EXPORT LOOP ===
  let pageNum = state.currentPage ?? 0;
  if (!config.fetchNewFirst || !hasResumeState) {
    pagesFetchedThisRun = 0; // Reset if we didn't do new phase
  }
  if (state.currentPage) {
    console.log(`Resuming from page ${state.currentPage}...`);
  }

  // Track if we completed a full scan (no more pages, not rate limited)
  let completedFullScan = false;

  while (true) {
    pageNum++;
    pagesFetchedThisRun++;
    state.currentPage = pageNum;

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
          completedFullScan = true;
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

    // Check if first 3 tweets already exist (more robust than single previousFirstExported)
    const checkCount = Math.min(3, bookmarksPage.length);
    let alreadyExistCount = 0;
    for (let i = 0; i < checkCount; i++) {
      const tweet = bookmarksPage[i];
      if (tweet && (await bookmarkExistsById(config.outputDir, tweet.id, tweet.createdAt, config.useDateFolders))) {
        alreadyExistCount++;
      }
    }
    if (checkCount > 0 && alreadyExistCount === checkCount) {
      console.log(
        `First ${checkCount} bookmarks already exported, stopping. (Cursor preserved for -R mode.)`
      );
      result.hitPreviousExport = true;
      // Return early without calling finishRun() - preserves cursor for -R mode
      return result;
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
      if (await bookmarkExists(config.outputDir, tweet, config.useDateFolders)) {
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
        const filename = await writeBookmarkMarkdown(processed, config.outputDir, config.useDateFolders);

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

    // Check if we've hit the max pages limit for this run
    if (config.maxPages && pagesFetchedThisRun >= config.maxPages) {
      if (nextCursor) {
        // More pages available - save state for resume
        state.nextCursor = nextCursor;
        state.currentPageBookmarks = undefined;
        await saveState(config.outputDir, state);
        console.log(`Reached max pages limit (${config.maxPages}). State saved. Run again to continue.`);
        // Return early - don't call finishRun which would clear the cursor
        return result;
      } else {
        console.log(`Reached max pages limit (${config.maxPages}), but no more pages available anyway.`);
        completedFullScan = true;
      }
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
      // No more pages - full scan completed
      console.log("No more pages available.");
      completedFullScan = true;
      break;
    }
  }

  // Finish run - update first exported tracking
  await finishRun(config.outputDir, { completedFullScan });

  return result;
}

// Backfill replies for an existing bookmark
async function backfillRepliesForBookmark(
  client: TwitterClient,
  tweet: TweetData,
  filepath: string,
  config: ExporterConfig
): Promise<boolean> {
  // Fetch replies (only replies, not thread since it's already in the file)
  const { replies } = await withRateLimitCheck(
    () => expandThread(client, tweet, true), // Always fetch replies for backfill
    `backfilling replies for ${tweet.id}`
  );

  if (replies.length === 0) {
    return false; // No replies to backfill
  }

  // Process replies with skipMedia (we don't want to download media for backfill)
  const processedReplies = await Promise.all(
    replies.map((t) => processTweet(t, config.outputDir, { skipMedia: true }))
  );

  // Generate replies section
  const repliesSection = generateRepliesSection(processedReplies, config.useDateFolders);

  // Append to existing file
  const existingContent = await Bun.file(filepath).text();
  await Bun.write(filepath, existingContent + repliesSection);

  return true;
}

// Rebuild mode: iterate all bookmarks from beginning, skip existing, optionally backfill replies/frontmatter
export async function exportBookmarksRebuild(
  client: TwitterClient,
  config: ExporterConfig
): Promise<ExportResult> {
  const result: ExportResult = {
    exported: 0,
    skipped: 0,
    errors: 0,
    hitPreviousExport: false,
    rateLimited: false,
    backfilled: 0,
    frontmatterAdded: 0,
  };

  // Ensure output directory exists
  await Bun.write(config.outputDir + "/.keep", "");
  await ensureAssetsDir(config.outputDir);

  // Load state (for resume on rate limit)
  let state = await loadState(config.outputDir);

  console.log("Starting rebuild mode...");
  if (config.backfillReplies) {
    console.log("Backfill replies: enabled");
  }
  if (config.backfillFrontmatter) {
    console.log("Backfill frontmatter: enabled");
  }

  // Start from beginning or resume from saved cursor
  let pageNum = state.currentPage ?? 0;
  let pagesFetchedThisRun = 0;
  let cursor = state.nextCursor; // Resume from cursor if exists (rate limit resume)

  if (cursor) {
    console.log(`Resuming rebuild from page ${pageNum}, cursor exists...`);
  } else {
    console.log("Starting rebuild from beginning (ignoring saved cursor)...");
    // Clear any existing cursor state for fresh rebuild
    state.nextCursor = undefined;
    state.currentPageBookmarks = undefined;
    state.currentPage = undefined;
  }

  // Track if we completed a full scan (no more pages, not rate limited)
  let completedFullScan = false;

  while (true) {
    pageNum++;
    pagesFetchedThisRun++;
    state.currentPage = pageNum;

    console.log(`Fetching bookmarks page ${pageNum}${cursor ? " (from cursor)" : ""}...`);

    try {
      const bookmarksResult = await withRateLimitCheck(
        () => client.getAllBookmarks({ maxPages: 1, cursor }),
        "fetching bookmarks"
      );

      if (!bookmarksResult.success) {
        throw new Error(bookmarksResult.error || "Failed to fetch bookmarks");
      }

      const bookmarksPage = bookmarksResult.tweets;
      const nextCursor = bookmarksResult.nextCursor;

      if (bookmarksPage.length === 0) {
        if (nextCursor) {
          // Empty page but cursor exists - might be a gap, try continuing
          console.log("Empty page but cursor exists, continuing...");
          cursor = nextCursor;
          state.nextCursor = cursor;
          await saveState(config.outputDir, state);
          continue;
        }
        console.log("No more bookmarks to process (empty page, no cursor).");
        completedFullScan = true;
        break;
      }

      console.log(`Got ${bookmarksPage.length} bookmarks${nextCursor ? ", more available" : ""}`);

      // Process each bookmark
      for (let i = 0; i < bookmarksPage.length; i++) {
        const tweet = bookmarksPage[i];
        if (!tweet) continue;

        // Check if already exported
        const existingPath = await findBookmarkPath(
          config.outputDir,
          tweet.id,
          tweet.createdAt,
          config.useDateFolders
        );

        if (existingPath) {
          // Bookmark exists - check for backfill options
          let didBackfill = false;

          // Frontmatter backfill
          if (config.backfillFrontmatter) {
            const hasFrontmatter = await bookmarkHasFrontmatter(existingPath);
            if (!hasFrontmatter) {
              console.log(`Adding frontmatter to ${tweet.id}...`);
              try {
                // Process tweet to get resolved URLs for metadata
                const processed = await processBookmark(client, tweet, {
                  ...config,
                  includeReplies: false, // Don't fetch replies just for frontmatter
                });
                await writeBookmarkMarkdown(processed, config.outputDir, {
                  useDateFolders: config.useDateFolders,
                  mergeExistingFrontmatter: true,
                  frontmatterOnly: true,
                });
                console.log(`  Added frontmatter to ${tweet.id}`);
                result.frontmatterAdded = (result.frontmatterAdded ?? 0) + 1;
                didBackfill = true;
              } catch (error) {
                if (error instanceof RateLimitError) throw error;
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`  Error adding frontmatter to ${tweet.id}: ${errorMessage}`);
                await appendError(config.outputDir, {
                  tweetId: tweet.id,
                  error: errorMessage,
                  timestamp: new Date().toISOString(),
                  context: `Adding frontmatter for @${tweet.author.username}`,
                });
                result.errors++;
              }
            } else {
              console.log(`Skipping ${tweet.id} (already has frontmatter)`);
            }
          }

          // Replies backfill
          if (config.backfillReplies && config.includeReplies) {
            const hasReplies = await bookmarkHasReplies(existingPath);
            if (!hasReplies) {
              console.log(`Backfilling replies for ${tweet.id}...`);
              try {
                const backfilled = await backfillRepliesForBookmark(
                  client,
                  tweet,
                  existingPath,
                  config
                );
                if (backfilled) {
                  console.log(`  Backfilled replies for ${tweet.id}`);
                  result.backfilled = (result.backfilled ?? 0) + 1;
                  didBackfill = true;
                } else {
                  console.log(`  No replies found for ${tweet.id}`);
                }
              } catch (error) {
                if (error instanceof RateLimitError) throw error;
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`  Error backfilling ${tweet.id}: ${errorMessage}`);
                await appendError(config.outputDir, {
                  tweetId: tweet.id,
                  error: errorMessage,
                  timestamp: new Date().toISOString(),
                  context: `Backfilling replies for @${tweet.author.username}`,
                });
                result.errors++;
              }
            } else if (!config.backfillFrontmatter) {
              console.log(`Skipping ${tweet.id} (already has replies)`);
            }
          }

          if (!didBackfill && !config.backfillReplies && !config.backfillFrontmatter) {
            console.log(`Skipping existing: ${tweet.id}`);
          }
          result.skipped++;
          continue;
        }

        // New bookmark - full export
        console.log(
          `Processing new bookmark ${i + 1}/${bookmarksPage.length}: @${tweet.author.username} - ${tweet.text.slice(0, 50)}...`
        );

        try {
          const processed = await processBookmark(client, tweet, config);
          const filename = await writeBookmarkMarkdown(processed, config.outputDir, {
            useDateFolders: config.useDateFolders,
          });
          console.log(`  Exported: ${filename}`);
          result.exported++;

          // Fetch any linked articles
          const { statusIds, tweetsWithArticleLinks } = collectLinkedIds(processed);
          if (statusIds.length > 0) {
            await fetchLinkedArticles(client, statusIds, config);
          }
          if (tweetsWithArticleLinks.length > 0) {
            await fetchArticlesFromTweetsWithArticleLinks(client, tweetsWithArticleLinks, config);
          }
        } catch (error) {
          if (error instanceof RateLimitError) {
            // Save cursor for resume
            state.nextCursor = cursor;
            await saveState(config.outputDir, state);
            console.error(`\n${error.message}. State saved. Resume rebuild later to continue.`);
            result.rateLimited = true;
            return result;
          }

          const errorMessage = error instanceof Error ? error.message : String(error);
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

      // Save cursor after each page (for resume on rate limit)
      cursor = nextCursor;
      state.nextCursor = cursor;
      state.currentPageBookmarks = undefined;
      await saveState(config.outputDir, state);

      // Log page summary
      const backfillStats = [
        result.backfilled ? `${result.backfilled} replies` : null,
        result.frontmatterAdded ? `${result.frontmatterAdded} frontmatter` : null,
      ].filter(Boolean).join(", ");
      console.log(
        `\n--- Page ${pageNum} complete | Total: ${result.exported} exported, ${result.skipped} skipped${backfillStats ? `, backfilled: ${backfillStats}` : ""}, ${result.errors} errors ---\n`
      );

      // Check max pages limit
      if (config.maxPages && pagesFetchedThisRun >= config.maxPages) {
        if (nextCursor) {
          console.log(`Reached max pages limit (${config.maxPages}). State saved. Run again to continue rebuild.`);
          return result;
        } else {
          console.log(`Reached max pages limit (${config.maxPages}), but no more pages available anyway.`);
          completedFullScan = true;
        }
        break;
      }

      // Move to next page
      if (!nextCursor) {
        console.log("No more pages available.");
        completedFullScan = true;
        break;
      }

      console.log(`Waiting ${PAGE_DELAY_MS / 1000}s before next page...`);
      await sleep(PAGE_DELAY_MS);
    } catch (error) {
      if (error instanceof RateLimitError) {
        state.nextCursor = cursor;
        await saveState(config.outputDir, state);
        console.error(`\n${error.message}. State saved. Resume rebuild later to continue.`);
        result.rateLimited = true;
        return result;
      }
      throw error;
    }
  }

  // Clear state on successful completion
  await finishRun(config.outputDir, { completedFullScan });

  return result;
}
