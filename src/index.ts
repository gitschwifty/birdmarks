import { resolve } from "path";
import { mkdir } from "fs/promises";
import { TwitterClient, resolveCredentials } from "@steipete/bird";
import { exportBookmarks, exportSingleTweet, exportBookmarksRebuild } from "./exporter";
import type { ExporterConfig } from "./types";

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let outputDir = "./bookmarks";
  let quoteDepth = 3;
  let cookieSource: "safari" | "chrome" | "firefox" | undefined;
  let singleTweetId: string | undefined;
  let includeReplies = false;
  let maxPages: number | undefined;
  let fetchNewFirst = false;
  let useDateFolders = false;
  let rebuildMode = false;
  let backfillReplies = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "-o" || arg === "--output") {
      const val = args[++i];
      if (val) outputDir = val;
    } else if (arg === "--quote-depth") {
      const val = args[++i];
      if (val) {
        const parsed = parseInt(val, 10);
        quoteDepth = parsed === -1 ? 20 : parsed; // -1 means "unlimited" (capped at 20)
      }
    } else if (arg === "--cookie-source") {
      const val = args[++i];
      if (val) cookieSource = val as "safari" | "chrome" | "firefox";
    } else if (arg === "-t" || arg === "--tweet") {
      const val = args[++i];
      if (val) singleTweetId = val;
    } else if (arg === "-r" || arg === "--replies") {
      includeReplies = true;
    } else if (arg === "-n" || arg === "--max-pages") {
      const val = args[++i];
      if (val) maxPages = parseInt(val, 10);
    } else if (arg === "-N" || arg === "--new-first") {
      fetchNewFirst = true;
    } else if (arg === "-d" || arg === "--date-folders") {
      useDateFolders = true;
    } else if (arg === "-R" || arg === "--rebuild") {
      rebuildMode = true;
    } else if (arg === "-B" || arg === "--backfill-replies") {
      backfillReplies = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      // Positional argument - could be output dir or tweet ID
      // Tweet IDs are all digits and typically 19+ chars
      if (/^\d{15,}$/.test(arg)) {
        singleTweetId = arg;
      } else {
        outputDir = arg;
      }
    }
  }

  // Resolve output directory
  outputDir = resolve(outputDir);

  console.log(`Output directory: ${outputDir}`);
  console.log(`Quote depth: ${quoteDepth}`);
  console.log(`Include replies: ${includeReplies}`);
  if (maxPages) console.log(`Max pages this run: ${maxPages}`);
  if (fetchNewFirst) console.log(`Fetch new first: enabled`);
  if (useDateFolders) console.log(`Date folders: enabled (yyyy/mm/)`);
  if (rebuildMode) console.log(`Rebuild mode: enabled`);
  if (backfillReplies) console.log(`Backfill replies: enabled`);
  console.log("");

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  // Get credentials
  console.log("Resolving Twitter credentials...");
  const credResult = await resolveCredentials({
    cookieSource: cookieSource ? [cookieSource] : ["chrome", "safari", "firefox"],
  });

  if (!credResult.cookies.authToken || !credResult.cookies.ct0) {
    console.error("Failed to get Twitter credentials.");
    console.error("Make sure you're logged into Twitter in your browser.");
    if (credResult.warnings.length > 0) {
      console.error("Warnings:", credResult.warnings);
    }
    process.exit(1);
  }

  console.log(`Using cookies from: ${credResult.cookies.source}`);
  if (credResult.warnings.length > 0) {
    console.warn("Warnings:", credResult.warnings);
  }
  console.log("");

  // Create Twitter client
  const client = new TwitterClient({
    cookies: credResult.cookies,
    quoteDepth,
  });

  // Verify we can connect
  console.log("Verifying connection...");
  const me = await client.getCurrentUser();
  if (!me.success || !me.user) {
    console.error("Failed to verify Twitter connection:", me.error);
    process.exit(1);
  }
  console.log(`Logged in as: @${me.user.username} (${me.user.name})`);
  console.log("");

  // Run export
  const config: ExporterConfig = {
    outputDir,
    quoteDepth,
    includeReplies,
    maxPages,
    fetchNewFirst,
    useDateFolders,
    rebuildMode,
    backfillReplies,
  };

  try {
    // Single tweet mode
    if (singleTweetId) {
      console.log(`Processing single tweet: ${singleTweetId}`);
      console.log("");

      const result = await exportSingleTweet(client, singleTweetId, config);

      console.log("");
      if (result.success) {
        console.log("=== Export Complete ===");
        console.log(`File: ${result.filename}`);
      } else {
        console.error("=== Export Failed ===");
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }
      return;
    }

    // Full bookmarks export
    const result = rebuildMode
      ? await exportBookmarksRebuild(client, config)
      : await exportBookmarks(client, config);

    console.log("");
    if (result.rateLimited) {
      console.log("=== Export Paused (Rate Limited) ===");
      console.log(`Exported: ${result.exported}`);
      console.log(`Skipped (already exists): ${result.skipped}`);
      if (result.backfilled !== undefined) console.log(`Backfilled replies: ${result.backfilled}`);
      console.log(`Errors: ${result.errors}`);
      console.log("\nRun again later to resume from where you left off.");
      process.exit(0); // Clean exit - state is saved
    } else {
      console.log("=== Export Complete ===");
      console.log(`Exported: ${result.exported}`);
      console.log(`Skipped (already exists): ${result.skipped}`);
      if (result.backfilled !== undefined) console.log(`Backfilled replies: ${result.backfilled}`);
      console.log(`Errors: ${result.errors}`);
      if (result.hitPreviousExport) {
        console.log("Stopped at previously exported bookmark.");
      }
    }
  } catch (error) {
    console.error("");
    console.error("Export failed:", error);
    console.error("State has been saved. Run again to resume.");
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
birdmarks - Export Twitter bookmarks to markdown

Usage:
  birdmarks [output-dir] [options]
  birdmarks --tweet <id> [options]
  birdmarks <tweet-id> [options]

Arguments:
  output-dir           Output directory for markdown files (default: ./bookmarks)
  tweet-id             Process a single tweet by ID (auto-detected if all digits)

Options:
  -t, --tweet <id>     Process a single tweet instead of all bookmarks
  -o, --output <dir>   Output directory (alternative to positional arg)
  -n, --max-pages <n>  Limit pages fetched this run (to avoid rate limits)
  -N, --new-first      Fetch new bookmarks first before resuming from cursor
  -d, --date-folders   Organize bookmarks into yyyy-mm subfolders
  -r, --replies        Include replies from other users (default: off)
  -R, --rebuild        Iterate all bookmarks from beginning (saves cursor for resume)
  -B, --backfill-replies  Backfill missing replies on existing bookmarks (use with -R)
  --quote-depth <n>    Maximum depth for quoted tweets (default: 3, -1 for unlimited)
  --cookie-source <s>  Browser to get cookies from: safari, chrome, firefox
  -h, --help           Show this help message

Examples:
  birdmarks ./my-bookmarks                    # Export all bookmarks
  birdmarks --tweet 2011168940404457736       # Export single tweet
  birdmarks 2011168940404457736               # Same as above (auto-detected)
  birdmarks -o ~/bookmarks --cookie-source firefox

Notes:
  - Requires being logged into Twitter in your browser
  - State is saved automatically for resume on rate limits
  - Run again to fetch new bookmarks (skips already exported)
  - Single tweet mode is useful for testing or re-running errors
`);
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
