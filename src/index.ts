import { resolve } from "path";
import { mkdir } from "fs/promises";
import { TwitterClient, resolveCredentials } from "@steipete/bird";
import { exportBookmarks } from "./exporter";
import type { ExporterConfig } from "./types";

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let outputDir = "./bookmarks";
  let quoteDepth = 3;
  let cookieSource: "safari" | "chrome" | "firefox" | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "-o" || arg === "--output") {
      const val = args[++i];
      if (val) outputDir = val;
    } else if (arg === "--quote-depth") {
      const val = args[++i];
      if (val) quoteDepth = parseInt(val, 10);
    } else if (arg === "--cookie-source") {
      const val = args[++i];
      if (val) cookieSource = val as "safari" | "chrome" | "firefox";
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      // Positional argument = output dir
      outputDir = arg;
    }
  }

  // Resolve output directory
  outputDir = resolve(outputDir);

  console.log(`Output directory: ${outputDir}`);
  console.log(`Quote depth: ${quoteDepth}`);
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
  };

  try {
    const result = await exportBookmarks(client, config);

    console.log("");
    if (result.rateLimited) {
      console.log("=== Export Paused (Rate Limited) ===");
      console.log(`Exported: ${result.exported}`);
      console.log(`Skipped (already exists): ${result.skipped}`);
      console.log(`Errors: ${result.errors}`);
      console.log("\nRun again later to resume from where you left off.");
      process.exit(0); // Clean exit - state is saved
    } else {
      console.log("=== Export Complete ===");
      console.log(`Exported: ${result.exported}`);
      console.log(`Skipped (already exists): ${result.skipped}`);
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
bird-bookmarks - Export Twitter bookmarks to markdown

Usage:
  bird-bookmarks [output-dir] [options]

Arguments:
  output-dir           Output directory for markdown files (default: ./bookmarks)

Options:
  -o, --output <dir>   Output directory (alternative to positional arg)
  --quote-depth <n>    Maximum depth for quoted tweets (default: 3)
  --cookie-source <s>  Browser to get cookies from: safari, chrome, firefox
  -h, --help           Show this help message

Examples:
  bird-bookmarks ./my-bookmarks
  bird-bookmarks -o ~/Documents/twitter-bookmarks --cookie-source safari

Notes:
  - Requires being logged into Twitter in your browser
  - State is saved automatically for resume on rate limits
  - Run again to fetch new bookmarks (skips already exported)
`);
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
