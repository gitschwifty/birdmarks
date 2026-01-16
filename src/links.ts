// Link resolution: resolve redirects and fetch page titles

interface ResolvedLink {
  originalUrl: string;
  resolvedUrl: string;
  title?: string;
}

// URL regex for t.co shortened URLs only
const TCO_URL_REGEX = /https?:\/\/t\.co\/[^\s<>"')\]]+/g;

// URL regex for Twitter/X photo/video links to remove (various formats)
// Matches twitter.com or x.com URLs containing /photo/ or /video/
const TWITTER_MEDIA_URL_REGEX = /https?:\/\/(twitter\.com|x\.com)\/[^\s]*\/(photo|video)\/\d+[^\s]*/g;

// Check if a URL is a twitter media URL (photo/video)
function isTwitterMediaUrl(url: string): boolean {
  return TWITTER_MEDIA_URL_REGEX.test(url);
}

// Check if a URL is a twitter status URL (potential article)
// Returns the tweet ID if it is, undefined otherwise
export function extractTwitterStatusId(url: string): string | undefined {
  const match = url.match(/https?:\/\/(twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/);
  return match?.[2];
}

// Check if a URL is a twitter article URL (x.com/i/article/...)
// Returns the article ID if it is, undefined otherwise
export function extractTwitterArticleId(url: string): string | undefined {
  const match = url.match(/https?:\/\/(twitter\.com|x\.com)\/i\/article\/(\d+)/);
  return match?.[2];
}

export async function resolveLink(url: string): Promise<ResolvedLink> {
  const result: ResolvedLink = {
    originalUrl: url,
    resolvedUrl: url,
  };

  try {
    // Use HEAD request to follow redirects
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });

    result.resolvedUrl = response.url;

    // If it's a different URL, try to get the title
    if (response.url !== url && response.ok) {
      result.title = await fetchPageTitle(response.url);
    }
  } catch (error) {
    // HEAD might be blocked, try GET with limited read
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });

      result.resolvedUrl = response.url;

      if (response.ok) {
        result.title = await fetchPageTitle(response.url);
      }
    } catch {
      // Failed to resolve, keep original URL
    }
  }

  return result;
}

async function fetchPageTitle(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      headers: {
        // Pretend to be a browser for better compatibility
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });

    if (!response.ok) return undefined;

    // Only read the first chunk to find title
    const text = await response.text();
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1];
    if (title) {
      // Clean up the title
      return title
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 200); // Limit length
    }
  } catch {
    // Failed to fetch title
  }
  return undefined;
}

export function unescapeText(text: string): string {
  // Unescape JSON-encoded characters
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

// Strip leading @mentions from reply text
// Matches one or more @username at the start of text
export function stripLeadingMentions(text: string): string {
  return text.replace(/^(@\w+\s*)+/, "").trim();
}

export interface ProcessTextResult {
  text: string;
  linkedStatusIds: string[]; // Twitter status IDs found in links (for article expansion)
  linkedArticleIds: string[]; // Twitter article IDs found (x.com/i/article/...)
}

export async function processTextLinks(text: string, skipLinkResolution: boolean = false): Promise<string> {
  const result = await processTextLinksWithMeta(text, skipLinkResolution);
  return result.text;
}

export async function processTextLinksWithMeta(text: string, skipLinkResolution: boolean = false): Promise<ProcessTextResult> {
  // First unescape
  let processed = unescapeText(text);
  const linkedStatusIds: string[] = [];
  const linkedArticleIds: string[] = [];

  // Remove Twitter/X photo/video links - media handled separately
  processed = processed.replace(TWITTER_MEDIA_URL_REGEX, "");

  // Remove pic.twitter.com and other media URLs
  processed = processed.replace(/https?:\/\/pic\.twitter\.com\/[^\s]+/g, "");
  processed = processed.replace(/https?:\/\/pbs\.twimg\.com\/[^\s]+/g, "");
  processed = processed.replace(/https?:\/\/video\.twimg\.com\/[^\s]+/g, "");

  // If skipping link resolution (e.g., for articles), just return cleaned text
  if (skipLinkResolution) {
    return { text: processed.trim(), linkedStatusIds, linkedArticleIds };
  }

  // Find only t.co URLs for resolution
  const urls = processed.match(TCO_URL_REGEX);
  if (!urls) return { text: processed.trim(), linkedStatusIds, linkedArticleIds };

  // Dedupe URLs
  const uniqueUrls = [...new Set(urls)];

  // Resolve each t.co URL
  for (const url of uniqueUrls) {
    const resolved = await resolveLink(url);

    // Reset regex state (global flag issue)
    TWITTER_MEDIA_URL_REGEX.lastIndex = 0;

    // If resolved URL is a twitter media URL, just remove it
    if (isTwitterMediaUrl(resolved.resolvedUrl)) {
      processed = processed.replace(new RegExp(escapeRegex(url), "g"), "");
      continue;
    }

    // Check if it's a twitter article URL (x.com/i/article/...)
    const articleId = extractTwitterArticleId(resolved.resolvedUrl);
    if (articleId) {
      linkedArticleIds.push(articleId);
    }

    // Check if it's a twitter status URL (potential article)
    const statusId = extractTwitterStatusId(resolved.resolvedUrl);
    if (statusId) {
      linkedStatusIds.push(statusId);
    }

    if (resolved.title && resolved.resolvedUrl !== url) {
      // Replace with markdown link using title
      processed = processed.replace(
        new RegExp(escapeRegex(url), "g"),
        `[${resolved.title}](${resolved.resolvedUrl})`
      );
    } else if (resolved.resolvedUrl !== url) {
      // Replace with resolved URL (no title found)
      processed = processed.replace(
        new RegExp(escapeRegex(url), "g"),
        resolved.resolvedUrl
      );
    }
    // If URL didn't change, leave it as-is
  }

  return { text: processed.trim(), linkedStatusIds, linkedArticleIds };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
