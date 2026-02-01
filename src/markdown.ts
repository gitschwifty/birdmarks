import { join } from "path";
import { mkdir } from "fs/promises";
import type { TweetData } from "@steipete/bird";
import type { ProcessedTweet, ProcessedBookmark, LocalMedia, BookmarkFrontmatter, LinkMetadata } from "./types";
import { processTextLinks, processTextLinksWithMeta, stripLeadingMentions } from "./links";
import { downloadMedia, ensureAssetsDir } from "./media";
import { bookmarkFilename, getDateFolder, sanitizeFilename } from "./state";
import { extractLinkMetadata } from "./metadata";
import { getMetadataWithCache } from "./metadata-cache";

const ARTICLES_DIR = "articles";

async function ensureArticlesDir(outputDir: string): Promise<void> {
  const articlesPath = join(outputDir, ARTICLES_DIR);
  await mkdir(articlesPath, { recursive: true });
}

// Extract hashtags from text (without the # prefix)
// Only extract from original tweet, not thread/replies
export function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\w]+/g) || [];
  return [...new Set(matches.map((tag) => tag.slice(1)))]; // Remove # prefix, dedupe
}

// Parse existing YAML frontmatter from markdown content
// Returns { frontmatter: parsed object or null, body: content after frontmatter }
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content };
  }

  // Find the closing ---
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: null, body: content };
  }

  const frontmatterStr = content.slice(4, endIndex); // Skip opening ---\n
  const body = content.slice(endIndex + 4).trimStart(); // Skip closing ---\n

  // Parse YAML (simple key-value parsing, handles our format)
  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of frontmatterStr.split("\n")) {
    // Array item
    if (line.startsWith("  - ") && currentKey && currentArray) {
      const value = line.slice(4).trim();
      // Handle link objects (multi-line)
      if (value.startsWith("url:")) {
        // Start of a link object - for now just skip complex nested objects
        // We'll preserve them as-is by not overwriting
        continue;
      }
      currentArray.push(value);
      continue;
    }

    // New key
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      // Save previous array if any
      if (currentKey && currentArray) {
        frontmatter[currentKey] = currentArray;
      }

      currentKey = match[1] ?? null;
      const value = match[2]?.trim() ?? "";

      if (value === "") {
        // Likely an array follows
        currentArray = [];
      } else {
        currentArray = null;
        // Parse the value
        frontmatter[currentKey!] = parseYamlValue(value);
      }
    }
  }

  // Save final array if any
  if (currentKey && currentArray) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body };
}

// Parse a simple YAML value (string, number, boolean)
function parseYamlValue(value: string): string | number | boolean {
  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  // Number
  if (/^\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;
  // Plain string
  return value;
}

// Merge new frontmatter into existing, preserving existing values
export function mergeFrontmatter(
  existing: Record<string, unknown>,
  generated: string
): string {
  // Parse the generated frontmatter
  const { frontmatter: newFm } = parseFrontmatter(generated + "\n# dummy body");
  if (!newFm) return generated;

  // Merge: existing values take precedence, but add new keys
  const merged: Record<string, unknown> = { ...newFm };
  for (const [key, value] of Object.entries(existing)) {
    if (value !== undefined && value !== null) {
      merged[key] = value;
    }
  }

  // Regenerate YAML from merged object
  return generateFrontmatterFromObject(merged);
}

// Generate frontmatter string from an object
function generateFrontmatterFromObject(obj: Record<string, unknown>): string {
  const lines: string[] = ["---"];

  // Maintain a specific order for readability
  const orderedKeys = [
    "id", "author", "author_name", "date", "url",
    "thread_length", "reply_count", "media_count", "quoted_tweet",
    "hashtags", "links"
  ];

  const writtenKeys = new Set<string>();

  // Write ordered keys first
  for (const key of orderedKeys) {
    if (key in obj) {
      writeYamlKey(lines, key, obj[key]);
      writtenKeys.add(key);
    }
  }

  // Write any remaining keys (custom ones from existing frontmatter)
  for (const [key, value] of Object.entries(obj)) {
    if (!writtenKeys.has(key)) {
      writeYamlKey(lines, key, value);
    }
  }

  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

// Write a single YAML key-value pair
function writeYamlKey(lines: string[], key: string, value: unknown): void {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    if (value.length === 0) return;

    // Check if it's an array of objects (links) or simple values
    if (typeof value[0] === "object" && value[0] !== null) {
      // Array of objects (links)
      lines.push(`${key}:`);
      for (const item of value as Record<string, unknown>[]) {
        let first = true;
        for (const [k, v] of Object.entries(item)) {
          if (v === undefined || v === null) continue;
          const prefix = first ? "  - " : "    ";
          first = false;
          if (Array.isArray(v)) {
            lines.push(`${prefix}${k}: [${(v as string[]).map(s => `"${s}"`).join(", ")}]`);
          } else if (typeof v === "string" && (v.includes('"') || v.includes("\n"))) {
            lines.push(`${prefix}${k}: "${escapeYamlString(v)}"`);
          } else if (typeof v === "string") {
            lines.push(`${prefix}${k}: ${v}`);
          } else {
            lines.push(`${prefix}${k}: ${v}`);
          }
        }
      }
    } else {
      // Array of simple values (hashtags)
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
    }
  } else if (typeof value === "string") {
    // Check if needs quoting
    if (key === "id" || key === "quoted_tweet" || key === "author_name" ||
        value.includes('"') || value.includes(":") || value.includes("\n")) {
      lines.push(`${key}: "${escapeYamlString(String(value))}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  } else if (typeof value === "number" || typeof value === "boolean") {
    lines.push(`${key}: ${value}`);
  }
}

// Generate YAML frontmatter for a bookmark
export function generateFrontmatter(
  bookmark: ProcessedBookmark,
  linkMetadata: LinkMetadata[]
): string {
  const tweet = bookmark.originalTweet;
  const lines: string[] = ["---"];

  // Basic tweet info
  lines.push(`id: "${tweet.id}"`);
  lines.push(`author: ${tweet.author.username}`);
  lines.push(`author_name: "${escapeYamlString(tweet.author.name)}"`);

  // Date in yyyy-mm-dd format
  if (tweet.createdAt) {
    const date = new Date(tweet.createdAt);
    const dateStr = date.toISOString().split("T")[0] ?? "unknown-date";
    lines.push(`date: ${dateStr}`);
  }

  // URL to tweet
  lines.push(`url: https://twitter.com/${tweet.author.username}/status/${tweet.id}`);

  // Thread length (original + thread tweets)
  const threadLength = 1 + bookmark.threadTweets.length;
  if (threadLength > 1) {
    lines.push(`thread_length: ${threadLength}`);
  }

  // Reply count
  if (bookmark.replies.length > 0) {
    lines.push(`reply_count: ${bookmark.replies.length}`);
  }

  // Media count (all media across original + thread)
  const mediaCount =
    tweet.localMedia.length +
    bookmark.threadTweets.reduce((sum, t) => sum + t.localMedia.length, 0);
  if (mediaCount > 0) {
    lines.push(`media_count: ${mediaCount}`);
  }

  // Quoted tweet ID (from original tweet only)
  if (tweet.processedQuotedTweet) {
    lines.push(`quoted_tweet: "${tweet.processedQuotedTweet.id}"`);
  }

  // Hashtags (from original tweet text only, before sanitization)
  // We need to extract from the raw text, not processedText which has sanitized hashtags
  const hashtags = extractHashtags(tweet.text);
  if (hashtags.length > 0) {
    lines.push("hashtags:");
    for (const tag of hashtags) {
      lines.push(`  - ${tag}`);
    }
  }

  // Links with metadata
  if (linkMetadata.length > 0) {
    lines.push("links:");
    for (const link of linkMetadata) {
      lines.push(`  - url: ${link.url}`);
      lines.push(`    type: ${link.type}`);
      if (link.owner) lines.push(`    owner: ${link.owner}`);
      if (link.repo) lines.push(`    repo: ${link.repo}`);
      if (link.description) lines.push(`    description: "${escapeYamlString(link.description)}"`);
      if (link.stars !== undefined) lines.push(`    stars: ${link.stars}`);
      if (link.language) lines.push(`    language: ${link.language}`);
      if (link.topics && link.topics.length > 0) {
        lines.push(`    topics: [${link.topics.map((t) => `"${t}"`).join(", ")}]`);
      }
      if (link.title) lines.push(`    title: "${escapeYamlString(link.title)}"`);
      if (link.site) lines.push(`    site: ${link.site}`);
    }
  }

  lines.push("---");
  lines.push("");

  return lines.join("\n");
}

// Escape special characters in YAML strings
function escapeYamlString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
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

  // Collect resolved URLs (from this tweet and quoted tweets)
  const resolvedUrls = [
    ...textResult.resolvedUrls,
    ...(processedQuotedTweet?.resolvedUrls ?? []),
  ];

  return {
    ...tweet,
    processedText: textResult.text,
    localMedia,
    processedQuotedTweet,
    linkedStatusIds,
    linkedArticleIds,
    resolvedUrls,
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

export interface WriteBookmarkOptions {
  useDateFolders?: boolean;
  mergeExistingFrontmatter?: boolean; // When true, preserve existing frontmatter fields
  frontmatterOnly?: boolean; // When true, only update frontmatter, keep existing body
}

export async function writeBookmarkMarkdown(
  bookmark: ProcessedBookmark,
  outputDir: string,
  options?: WriteBookmarkOptions | boolean // boolean for backward compat (useDateFolders)
): Promise<string> {
  // Handle backward compatibility: if options is boolean, it's useDateFolders
  const opts: WriteBookmarkOptions = typeof options === "boolean"
    ? { useDateFolders: options }
    : options ?? {};

  const filename = bookmarkFilename(bookmark.originalTweet, opts.useDateFolders);

  let filepath: string;
  let relativePath: string;

  if (opts.useDateFolders) {
    const folder = getDateFolder(bookmark.originalTweet.createdAt);
    const folderPath = join(outputDir, folder);
    await mkdir(folderPath, { recursive: true });
    filepath = join(folderPath, filename);
    relativePath = join(folder, filename);
  } else {
    filepath = join(outputDir, filename);
    relativePath = filename;
  }

  // Check for existing file if we need to merge or preserve body
  let existingFrontmatter: Record<string, unknown> | null = null;
  let existingBody: string | null = null;

  if (opts.mergeExistingFrontmatter || opts.frontmatterOnly) {
    const file = Bun.file(filepath);
    if (await file.exists()) {
      const content = await file.text();
      const parsed = parseFrontmatter(content);
      existingFrontmatter = parsed.frontmatter;
      existingBody = parsed.body;
    }
  }

  // Collect all resolved URLs from original tweet + thread (not replies)
  // for frontmatter metadata extraction
  const allResolvedUrls = [
    ...bookmark.originalTweet.resolvedUrls,
    ...bookmark.threadTweets.flatMap((t) => t.resolvedUrls),
  ];

  // Dedupe by URL
  const uniqueUrls = new Map<string, { url: string; ogMetadata?: LinkMetadata }>();
  for (const resolved of allResolvedUrls) {
    if (!uniqueUrls.has(resolved.url)) {
      uniqueUrls.set(resolved.url, resolved);
    }
  }

  // Fetch metadata for each unique URL (with caching)
  const linkMetadata: LinkMetadata[] = [];
  for (const [url, resolved] of uniqueUrls) {
    try {
      // If we already have OG metadata from link resolution, use it for articles
      // For GitHub, we need to fetch from the API
      const metadata = await getMetadataWithCache(outputDir, url, async (u) => {
        const fetched = await extractLinkMetadata(u);
        // If we have pre-fetched OG metadata and this is an article, merge it
        if (resolved.ogMetadata && fetched.type === "article") {
          return {
            ...fetched,
            title: fetched.title || resolved.ogMetadata.title,
            description: fetched.description || resolved.ogMetadata.description,
            site: fetched.site || resolved.ogMetadata.site,
          };
        }
        return fetched;
      });
      linkMetadata.push(metadata);
    } catch {
      // Failed to fetch metadata - add with unknown type
      linkMetadata.push({ url, type: "unknown" });
    }
  }

  // Generate frontmatter
  let frontmatter = generateFrontmatter(bookmark, linkMetadata);

  // Merge with existing frontmatter if requested
  if (opts.mergeExistingFrontmatter && existingFrontmatter) {
    frontmatter = mergeFrontmatter(existingFrontmatter, frontmatter);
  }

  // Determine body content
  let body: string;
  if (opts.frontmatterOnly && existingBody !== null) {
    // Keep existing body, just update frontmatter
    body = existingBody;
  } else {
    // Generate new markdown body
    body = generateMarkdown(bookmark);
    // Adjust asset paths when using date folders (two levels deeper: yyyy/mm/)
    if (opts.useDateFolders) {
      body = body.replace(/\!\[\]\(assets\//g, "![](../../assets/");
    }
  }

  // Write file
  await Bun.write(filepath, frontmatter + body);

  // Extract articles from all tweets (original, thread, replies) and their quoted tweets
  // Skip if we're only updating frontmatter
  if (!opts.frontmatterOnly) {
    await extractArticlesFromTweet(bookmark.originalTweet, outputDir);
    for (const tweet of bookmark.threadTweets) {
      await extractArticlesFromTweet(tweet, outputDir);
    }
    for (const tweet of bookmark.replies) {
      await extractArticlesFromTweet(tweet, outputDir);
    }
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
