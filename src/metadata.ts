// Link metadata extraction: GitHub API, OG tags for articles/YouTube

import type { LinkMetadata } from "./types";

// Detect link type from URL
export function detectLinkType(url: string): "github" | "youtube" | "article" | "unknown" {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // GitHub: github.com/{owner}/{repo}
    if (host === "github.com" || host === "www.github.com") {
      // Check if it's a repo URL (has owner/repo pattern)
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      if (pathParts.length >= 2) {
        return "github";
      }
      return "article"; // GitHub but not a repo (e.g., github.com/features)
    }

    // YouTube
    if (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "youtu.be" ||
      host === "m.youtube.com"
    ) {
      return "youtube";
    }

    return "article";
  } catch {
    return "unknown";
  }
}

// Extract owner and repo from GitHub URL
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    if (pathParts.length >= 2) {
      const owner = pathParts[0];
      // Repo name might be followed by /tree/main, /blob/xxx, etc.
      const repo = pathParts[1];
      if (owner && repo) {
        return { owner, repo };
      }
    }
  } catch {
    // Invalid URL
  }
  return null;
}

// Extract metadata from GitHub repo using the API (no auth, 60 req/hr limit)
export async function extractGitHubMetadata(url: string): Promise<LinkMetadata> {
  const parsed = parseGitHubUrl(url);

  if (!parsed) {
    return { url, type: "github" };
  }

  const { owner, repo } = parsed;

  try {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "birdmarks/1.0",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      // Rate limited or not found - return basic metadata
      return { url, type: "github", owner, repo };
    }

    const data = (await response.json()) as {
      description?: string;
      stargazers_count?: number;
      language?: string;
      topics?: string[];
    };

    return {
      url,
      type: "github",
      owner,
      repo,
      description: data.description || undefined,
      stars: data.stargazers_count,
      language: data.language || undefined,
      topics: data.topics && data.topics.length > 0 ? data.topics : undefined,
    };
  } catch {
    // API call failed - return basic metadata
    return { url, type: "github", owner, repo };
  }
}

// Extract OG metadata from a page (og:title, og:description, og:site_name)
export async function extractOGMetadata(
  url: string,
  type: "youtube" | "article" = "article"
): Promise<LinkMetadata> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      return { url, type };
    }

    const html = await response.text();
    return parseOGTags(url, html, type);
  } catch {
    return { url, type };
  }
}

// Parse OG tags from HTML
export function parseOGTags(
  url: string,
  html: string,
  type: "youtube" | "article" = "article"
): LinkMetadata {
  const metadata: LinkMetadata = { url, type };

  // og:title
  const titleMatch = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  ) || html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
  );
  if (titleMatch?.[1]) {
    metadata.title = decodeHtmlEntities(titleMatch[1].trim());
  }

  // og:description
  const descMatch = html.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
  ) || html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i
  );
  if (descMatch?.[1]) {
    metadata.description = decodeHtmlEntities(descMatch[1].trim());
  }

  // og:site_name
  const siteMatch = html.match(
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i
  ) || html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i
  );
  if (siteMatch?.[1]) {
    metadata.site = decodeHtmlEntities(siteMatch[1].trim());
  } else {
    // Fall back to hostname as site
    try {
      metadata.site = new URL(url).hostname;
    } catch {
      // Invalid URL
    }
  }

  return metadata;
}

// Decode HTML entities in OG tag content
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

// Main entry point - routes to appropriate extractor
export async function extractLinkMetadata(url: string): Promise<LinkMetadata> {
  const type = detectLinkType(url);

  switch (type) {
    case "github":
      return extractGitHubMetadata(url);
    case "youtube":
      return extractOGMetadata(url, "youtube");
    case "article":
      return extractOGMetadata(url, "article");
    default:
      return { url, type: "unknown" };
  }
}
