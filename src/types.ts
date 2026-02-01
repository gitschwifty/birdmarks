import type { TweetData } from "@steipete/bird";

// Link metadata for frontmatter
export interface LinkMetadata {
  url: string;
  type: "github" | "youtube" | "article" | "unknown";
  title?: string;
  description?: string;
  site?: string;
  // GitHub-specific
  owner?: string;
  repo?: string;
  stars?: number;
  language?: string;
  topics?: string[];
}

// YAML frontmatter structure for bookmark markdown files
export interface BookmarkFrontmatter {
  id: string;
  author: string;
  author_name: string;
  date: string; // ISO date (yyyy-mm-dd)
  url: string;
  thread_length?: number;
  reply_count?: number;
  media_count?: number;
  quoted_tweet?: string;
  hashtags?: string[];
  links?: LinkMetadata[];
}

// Resolved URL with optional pre-fetched OG metadata
export interface ResolvedUrl {
  url: string;
  ogMetadata?: LinkMetadata;
}

// Extended tweet data with processed fields
export interface ProcessedTweet extends TweetData {
  processedText: string; // Text with resolved links, unescaped
  localMedia: LocalMedia[]; // Downloaded media paths
  processedQuotedTweet?: ProcessedTweet; // Recursively processed quoted tweet
  linkedStatusIds: string[]; // Twitter status IDs found in links (for article expansion)
  linkedArticleIds: string[]; // Twitter article IDs found (x.com/i/article/...)
  resolvedUrls: ResolvedUrl[]; // Resolved URLs for metadata extraction
}

export interface LocalMedia {
  type: "photo" | "video" | "animated_gif";
  localPath: string; // Relative path from output dir (e.g., "assets/xyz.jpg")
  originalUrl: string;
}

// Full processed bookmark with thread and replies
export interface ProcessedBookmark {
  originalTweet: ProcessedTweet;
  threadTweets: ProcessedTweet[]; // Author's reply chain (not including original)
  replies: ProcessedTweet[]; // Other users' replies
}

// State for resuming
export interface ExporterState {
  // Pagination state
  nextCursor?: string;
  currentPageBookmarks?: TweetData[];
  currentPage?: number;

  // First-exported tracking
  previousFirstExported?: string; // From last completed run
  currentRunFirstExported?: string; // Set on first export of current run

  // Completion tracking
  allBookmarksProcessed?: boolean; // Set true when no more pages
  lastFullScanAt?: string; // ISO timestamp of completion
}

// Error tracking
export interface ExportError {
  tweetId: string;
  error: string;
  timestamp: string;
  context?: string;
}

// Config for the exporter
export interface ExporterConfig {
  outputDir: string;
  quoteDepth: number;
  includeReplies: boolean;
  maxPages?: number; // Limit pages per run (undefined = unlimited)
  fetchNewFirst?: boolean; // Fetch new bookmarks before resuming from cursor
  useDateFolders?: boolean; // Organize bookmarks into yyyy-mm subfolders
  rebuildMode?: boolean; // Iterate all bookmarks from beginning, save cursor as you go
  backfillReplies?: boolean; // Backfill missing replies on existing bookmarks (use with -R)
  backfillFrontmatter?: boolean; // Add/update frontmatter on existing bookmarks (use with -R)
}
