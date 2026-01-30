import { join } from "path";
import { mkdir } from "fs/promises";
import type { TweetData } from "@steipete/bird";
import type { ProcessedTweet, ProcessedBookmark, LocalMedia } from "./types";
import { processTextLinks, processTextLinksWithMeta, stripLeadingMentions } from "./links";
import { downloadMedia, ensureAssetsDir } from "./media";
import { bookmarkFilename, getDateFolder, sanitizeFilename } from "./state";

const ARTICLES_DIR = "articles";

async function ensureArticlesDir(outputDir: string): Promise<void> {
  const articlesPath = join(outputDir, ARTICLES_DIR);
  await mkdir(articlesPath, { recursive: true });
}

// Shared helper for formatting article content in tweets
function formatArticleContent(tweet: ProcessedTweet, prefix: string = ""): string[] {
  if (!tweet.article) return [];
  const lines: string[] = [];
  lines.push(`${prefix}**${tweet.article.title}**`);
  if (tweet.article.previewText) {
    lines.push(`${prefix}`);
    lines.push(`${prefix}> ${tweet.article.previewText}`);
  }
  lines.push(`${prefix}`);
  lines.push(`${prefix}[Read full article](articles/${sanitizeFilename(tweet.article.title).slice(0, 100)}.md)`);
  return lines;
}

export interface ProcessTweetOptions {
  skipMedia?: boolean; // Skip downloading media, use original URLs instead
}

// Recursively process a tweet and its quoted tweets
export async function processTweet(
  tweet: TweetData,
  outputDir: string,
  options?: ProcessTweetOptions
): Promise<ProcessedTweet> {
  // Process text (unescape, resolve links)
  const textResult = await processTextLinksWithMeta(tweet.text);

  // Download media (or use original URLs if skipMedia is true)
  let localMedia: LocalMedia[] = [];
  if (tweet.media && tweet.media.length > 0) {
    if (options?.skipMedia) {
      // Use original URLs as placeholder (existing ![](localPath) syntax works)
      localMedia = tweet.media.map((m) => ({
        type: m.type,
        localPath: m.url,
        originalUrl: m.url,
      }));
    } else {
      await ensureAssetsDir(outputDir);
      localMedia = await downloadMedia(tweet.media, outputDir);
    }
  }

  // Recursively process quoted tweet if present
  let processedQuotedTweet: ProcessedTweet | undefined;
  if (tweet.quotedTweet) {
    processedQuotedTweet = await processTweet(tweet.quotedTweet, outputDir, options);
  }

  // Collect all linked IDs (from this tweet and quoted tweets)
  const linkedStatusIds = [
    ...textResult.linkedStatusIds,
    ...(processedQuotedTweet?.linkedStatusIds ?? []),
  ];
  const linkedArticleIds = [
    ...textResult.linkedArticleIds,
    ...(processedQuotedTweet?.linkedArticleIds ?? []),
  ];

  return {
    ...tweet,
    processedText: textResult.text,
    localMedia,
    processedQuotedTweet,
    linkedStatusIds,
    linkedArticleIds,
  };
}

function formatProcessedQuotedTweet(tweet: ProcessedTweet, depth: number = 1): string {
  const prefix = "> ".repeat(depth);
  const lines: string[] = [];

  lines.push(`${prefix}**@${tweet.author.username}** (${tweet.author.name})`);
  lines.push(`${prefix}`);

  // For article tweets, show title + preview + link to article file
  if (tweet.article) {
    lines.push(...formatArticleContent(tweet, prefix));
  } else {
    // Add processed text, prefixing each line
    const textLines = tweet.processedText.split("\n");
    for (const line of textLines) {
      lines.push(`${prefix}${line}`);
    }
  }

  // Handle nested quoted tweet (use processed version)
  if (tweet.processedQuotedTweet) {
    lines.push(`${prefix}`);
    lines.push(formatProcessedQuotedTweet(tweet.processedQuotedTweet, depth + 1));
  }

  // Media from quoted tweet
  if (tweet.localMedia.length > 0) {
    lines.push(`${prefix}`);
    for (const media of tweet.localMedia) {
      lines.push(`${prefix}![](${media.localPath})`);
    }
  }

  return lines.join("\n");
}

function formatTweet(
  tweet: ProcessedTweet,
  options: {
    includeHeader?: boolean;
    includeDate?: boolean;
    includeLink?: boolean;
  } = {}
): string {
  const lines: string[] = [];

  // Header with username
  if (options.includeHeader !== false) {
    lines.push(`**@${tweet.author.username}** (${tweet.author.name})`);
  }

  // Date
  if (options.includeDate && tweet.createdAt) {
    const date = new Date(tweet.createdAt);
    const dateStr = date.toISOString().split("T")[0] ?? "unknown-date";
    lines.push(dateStr);
  }

  // Link to tweet
  if (options.includeLink) {
    lines.push(
      `[View on Twitter](https://twitter.com/${tweet.author.username}/status/${tweet.id})`
    );
  }

  lines.push("");

  // Tweet text - for article tweets, show title + preview + link to article file
  if (tweet.article) {
    lines.push(...formatArticleContent(tweet));
  } else {
    lines.push(tweet.processedText);
  }

  // Quoted tweet (use processed version)
  if (tweet.processedQuotedTweet) {
    lines.push("");
    lines.push(formatProcessedQuotedTweet(tweet.processedQuotedTweet));
  }

  // Media
  if (tweet.localMedia.length > 0) {
    lines.push("");
    for (const media of tweet.localMedia) {
      lines.push(`![](${media.localPath})`);
    }
  }

  return lines.join("\n");
}

export function formatReply(tweet: ProcessedTweet): string {
  const lines: string[] = [];

  lines.push(`**@${tweet.author.username}** (${tweet.author.name})`);
  lines.push(
    `[View on Twitter](https://twitter.com/${tweet.author.username}/status/${tweet.id})`
  );
  lines.push("");

  // For article tweets, show title + preview + link to article file
  if (tweet.article) {
    lines.push(...formatArticleContent(tweet));
  } else {
    // Strip leading @mentions from replies (they're just reply-to indicators)
    lines.push(stripLeadingMentions(tweet.processedText));
  }

  // Quoted tweet in reply (use processed version)
  if (tweet.processedQuotedTweet) {
    lines.push("");
    lines.push(formatProcessedQuotedTweet(tweet.processedQuotedTweet));
  }

  // Media
  if (tweet.localMedia.length > 0) {
    lines.push("");
    for (const media of tweet.localMedia) {
      lines.push(`![](${media.localPath})`);
    }
  }

  return lines.join("\n");
}

export function generateMarkdown(bookmark: ProcessedBookmark): string {
  const lines: string[] = [];

  // Thread header
  lines.push("# Thread");
  lines.push("");

  // Original tweet with full formatting
  lines.push(
    formatTweet(bookmark.originalTweet, {
      includeHeader: true,
      includeDate: true,
      includeLink: true,
    })
  );

  // Thread continuation
  for (const tweet of bookmark.threadTweets) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(
      formatTweet(tweet, {
        includeHeader: false, // Same author, don't repeat
        includeDate: false,
        includeLink: false,
      })
    );
  }

  // Replies section
  if (bookmark.replies.length > 0) {
    lines.push("");
    lines.push("## Replies");
    lines.push("");

    for (let i = 0; i < bookmark.replies.length; i++) {
      const reply = bookmark.replies[i];
      if (!reply) continue;
      if (i > 0) {
        lines.push("");
        lines.push("---");
        lines.push("");
      }
      lines.push(formatReply(reply));
    }
  }

  return lines.join("\n");
}

// Generate markdown for an article and return the filename
async function generateArticleMarkdown(tweet: TweetData): Promise<{ filename: string; content: string } | null> {
  if (!tweet.article) return null;

  const lines: string[] = [];

  // Title
  const title = tweet.article.title || "Untitled Article";
  lines.push(`# ${title}`);
  lines.push("");

  // Author
  lines.push(`**@${tweet.author.username}** (${tweet.author.name})`);

  // Date
  if (tweet.createdAt) {
    const date = new Date(tweet.createdAt);
    const dateStr = date.toISOString().split("T")[0] ?? "unknown-date";
    lines.push(dateStr);
  }

  lines.push("");

  // Article text - process t.co links if any exist, unescape text
  const articleText = await processTextLinks(tweet.text);
  lines.push(articleText);

  // Sanitize title for filename
  const safeTitle = sanitizeFilename(title).slice(0, 100); // Limit length

  return {
    filename: `${safeTitle}.md`,
    content: lines.join("\n"),
  };
}

// Recursively extract articles from a tweet and its quoted tweets
async function extractArticlesFromTweet(
  tweet: ProcessedTweet | TweetData,
  outputDir: string
): Promise<void> {
  // Write article if this tweet has one AND has real content (not just a link)
  // Bookmarks API returns article metadata but text is just t.co link - skip those
  // They'll be handled by fetchArticlesFromTweetsWithArticleLinks
  if (tweet.article && tweet.text.length > 300) {
    const articleResult = await generateArticleMarkdown(tweet);
    if (articleResult) {
      await ensureArticlesDir(outputDir);
      const articlePath = join(outputDir, ARTICLES_DIR, articleResult.filename);
      if (!(await Bun.file(articlePath).exists())) {
        try {
          await Bun.write(articlePath, articleResult.content);
          console.log(`  Saved article: ${articleResult.filename}`);
        } catch (error) {
          console.error(`  Failed to save article ${articleResult.filename}: ${error}`);
        }
      }
    }
  }

  // Check quoted tweet (use processedQuotedTweet if available, otherwise quotedTweet)
  const quotedTweet = 'processedQuotedTweet' in tweet
    ? tweet.processedQuotedTweet
    : tweet.quotedTweet;

  if (quotedTweet) {
    await extractArticlesFromTweet(quotedTweet, outputDir);
  }
}

export async function writeBookmarkMarkdown(
  bookmark: ProcessedBookmark,
  outputDir: string,
  useDateFolders?: boolean
): Promise<string> {
  const filename = bookmarkFilename(bookmark.originalTweet, useDateFolders);

  let filepath: string;
  let relativePath: string;

  if (useDateFolders) {
    const folder = getDateFolder(bookmark.originalTweet.createdAt);
    const folderPath = join(outputDir, folder);
    await mkdir(folderPath, { recursive: true });
    filepath = join(folderPath, filename);
    relativePath = join(folder, filename);
  } else {
    filepath = join(outputDir, filename);
    relativePath = filename;
  }

  let markdown = generateMarkdown(bookmark);

  // Adjust asset paths when using date folders (two levels deeper: yyyy/mm/)
  if (useDateFolders) {
    markdown = markdown.replace(/\!\[\]\(assets\//g, "![](../../assets/");
  }

  await Bun.write(filepath, markdown);

  // Extract articles from all tweets (original, thread, replies) and their quoted tweets
  await extractArticlesFromTweet(bookmark.originalTweet, outputDir);
  for (const tweet of bookmark.threadTweets) {
    await extractArticlesFromTweet(tweet, outputDir);
  }
  for (const tweet of bookmark.replies) {
    await extractArticlesFromTweet(tweet, outputDir);
  }

  return relativePath;
}

// Write article from a linked tweet (fetched via getTweet)
export async function writeArticleFromTweet(
  tweet: TweetData,
  outputDir: string
): Promise<string | null> {
  if (!tweet.article) return null;

  const articleResult = await generateArticleMarkdown(tweet);
  if (!articleResult) return null;

  await ensureArticlesDir(outputDir);
  const articlePath = join(outputDir, ARTICLES_DIR, articleResult.filename);

  // Check if already exists
  if (await Bun.file(articlePath).exists()) {
    return null; // Already written
  }

  try {
    await Bun.write(articlePath, articleResult.content);
    return articleResult.filename;
  } catch (error) {
    console.error(`  Failed to save article ${articleResult.filename}: ${error}`);
    return null;
  }
}

// Generate a replies section for appending to an existing bookmark file
export function generateRepliesSection(
  replies: ProcessedTweet[],
  useDateFolders?: boolean
): string {
  if (replies.length === 0) return "";

  const lines: string[] = [];
  lines.push("");
  lines.push("## Replies");
  lines.push("");

  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i];
    if (!reply) continue;
    if (i > 0) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    lines.push(formatReply(reply));
  }

  let markdown = lines.join("\n");

  // Adjust asset paths when using date folders (two levels deeper: yyyy/mm/)
  if (useDateFolders) {
    markdown = markdown.replace(/\!\[\]\(assets\//g, "![](../../assets/");
  }

  return markdown;
}
