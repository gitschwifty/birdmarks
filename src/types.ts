import type { TweetData } from "@steipete/bird";

// Extended tweet data with processed fields
export interface ProcessedTweet extends TweetData {
  processedText: string; // Text with resolved links, unescaped
  localMedia: LocalMedia[]; // Downloaded media paths
  processedQuotedTweet?: ProcessedTweet; // Recursively processed quoted tweet
  linkedStatusIds: string[]; // Twitter status IDs found in links (for article expansion)
  linkedArticleIds: string[]; // Twitter article IDs found (x.com/i/article/...)
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

  // First-exported tracking
  previousFirstExported?: string; // From last completed run
  currentRunFirstExported?: string; // Set on first export of current run
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
}
