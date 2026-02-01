import { join } from "path";
import type { ExporterState, ExportError } from "./types";

const STATE_FILE = "exporter-state.json";
const ERRORS_FILE = "errors.json";

export async function loadState(outputDir: string): Promise<ExporterState> {
  const statePath = join(outputDir, STATE_FILE);
  const file = Bun.file(statePath);

  if (await file.exists()) {
    try {
      return await file.json();
    } catch {
      console.warn(`Warning: Could not parse ${STATE_FILE}, starting fresh`);
    }
  }
  return {};
}

export async function saveState(
  outputDir: string,
  state: ExporterState
): Promise<void> {
  const statePath = join(outputDir, STATE_FILE);
  await Bun.write(statePath, JSON.stringify(state, null, 2));
}

export async function clearPaginationState(outputDir: string): Promise<void> {
  const state = await loadState(outputDir);
  delete state.nextCursor;
  delete state.currentPageBookmarks;
  delete state.currentPage;
  await saveState(outputDir, state);
}

export interface FinishRunOptions {
  completedFullScan?: boolean; // True when all bookmarks were processed (no more pages)
}

export async function finishRun(outputDir: string, options?: FinishRunOptions): Promise<void> {
  const state = await loadState(outputDir);

  // Current run's first becomes previous for next run
  if (state.currentRunFirstExported) {
    state.previousFirstExported = state.currentRunFirstExported;
    delete state.currentRunFirstExported;
  }

  // Clear pagination state
  delete state.nextCursor;
  delete state.currentPageBookmarks;
  delete state.currentPage;

  // Mark completion if this was a full scan
  if (options?.completedFullScan) {
    state.allBookmarksProcessed = true;
    state.lastFullScanAt = new Date().toISOString();
  }

  await saveState(outputDir, state);
}

export async function loadErrors(outputDir: string): Promise<ExportError[]> {
  const errorsPath = join(outputDir, ERRORS_FILE);
  const file = Bun.file(errorsPath);

  if (await file.exists()) {
    try {
      return await file.json();
    } catch {
      return [];
    }
  }
  return [];
}

export async function appendError(
  outputDir: string,
  error: ExportError
): Promise<void> {
  const errors = await loadErrors(outputDir);
  errors.push(error);
  const errorsPath = join(outputDir, ERRORS_FILE);
  await Bun.write(errorsPath, JSON.stringify(errors, null, 2));
}

// Sanitize a string for use in filenames - removes problematic characters
export function sanitizeFilename(str: string): string {
  return (
    str
      // Replace curly quotes/apostrophes with nothing (cleaner than ASCII equivalents)
      .replace(/['']/g, "")
      .replace(/[""]/g, "")
      // Replace other common Unicode punctuation
      .replace(/[–—]/g, "-") // en-dash, em-dash
      .replace(/[…]/g, "") // Unicode ellipsis - just remove
      .replace(/\.{2,}/g, "") // Multiple dots - remove (avoid extension confusion)
      // Remove any remaining non-ASCII characters
      .replace(/[^\x00-\x7F]/g, "")
      // Remove filesystem-invalid characters and Obsidian link-breaking characters
      // Obsidian: # (tags/headings), | (alias), [] (links), ^ (block refs), () (annoying), ! (embeds), commas
      .replace(/[<>:"/\\|?*#\[\]^()!,]/g, "")
      // Replace spaces and multiple dashes with single dash
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      // Remove leading/trailing dashes and dots
      .replace(/^[-.]+|[-.]+$/g, "")
  );
}

// Get yyyy/mm folder path from a date
export function getDateFolder(createdAt?: string): string {
  if (!createdAt) return "unknown-date";
  const date = new Date(createdAt);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}`;
}

export function bookmarkFilename(
  tweet: {
    id: string;
    createdAt?: string;
    author: { username: string };
  },
  useDateFolders?: boolean
): string {
  // Format: yyyy-mm-dd-handle-id.md (or dd-handle-id.md when in date folders)
  let datePart = "unknown-date";
  if (tweet.createdAt) {
    const date = new Date(tweet.createdAt);
    if (useDateFolders) {
      // Just the day when folder already has yyyy-mm
      datePart = String(date.getUTCDate()).padStart(2, "0");
    } else {
      datePart = date.toISOString().split("T")[0] ?? "unknown-date"; // yyyy-mm-dd
    }
  }
  const safeUsername = sanitizeFilename(tweet.author.username);
  return `${datePart}-${safeUsername}-${tweet.id}.md`;
}

export async function bookmarkExists(
  outputDir: string,
  tweet: { id: string; createdAt?: string; author: { username: string } },
  useDateFolders?: boolean
): Promise<boolean> {
  const filename = bookmarkFilename(tweet, useDateFolders);
  if (useDateFolders) {
    const folder = getDateFolder(tweet.createdAt);
    const filepath = join(outputDir, folder, filename);
    return await Bun.file(filepath).exists();
  }
  const filepath = join(outputDir, filename);
  return await Bun.file(filepath).exists();
}

// Check if bookmark exists by date + tweet ID (handles username changes, fast lookup)
export async function bookmarkExistsById(
  outputDir: string,
  tweetId: string,
  createdAt?: string,
  useDateFolders?: boolean
): Promise<boolean> {
  // Use date prefix to narrow search if available
  let pattern: string;
  if (createdAt) {
    const date = new Date(createdAt);
    if (useDateFolders) {
      const folder = getDateFolder(createdAt);
      const day = String(date.getUTCDate()).padStart(2, "0");
      pattern = `${folder}/${day}-*-${tweetId}.md`;
    } else {
      const datePart = date.toISOString().split("T")[0] ?? "unknown-date";
      pattern = `${datePart}-*-${tweetId}.md`;
    }
  } else {
    // Without date, need to search more broadly
    pattern = useDateFolders ? `*/*-${tweetId}.md` : `*-${tweetId}.md`;
  }

  const glob = new Bun.Glob(pattern);
  for await (const _ of glob.scan(outputDir)) {
    return true; // Found at least one match
  }
  return false;
}

// Find the path to an existing bookmark file by tweet ID
export async function findBookmarkPath(
  outputDir: string,
  tweetId: string,
  createdAt?: string,
  useDateFolders?: boolean
): Promise<string | null> {
  // Use date prefix to narrow search if available
  let pattern: string;
  if (createdAt) {
    const date = new Date(createdAt);
    if (useDateFolders) {
      const folder = getDateFolder(createdAt);
      const day = String(date.getUTCDate()).padStart(2, "0");
      pattern = `${folder}/${day}-*-${tweetId}.md`;
    } else {
      const datePart = date.toISOString().split("T")[0] ?? "unknown-date";
      pattern = `${datePart}-*-${tweetId}.md`;
    }
  } else {
    // Without date, need to search more broadly
    pattern = useDateFolders ? `*/*-${tweetId}.md` : `*-${tweetId}.md`;
  }

  const glob = new Bun.Glob(pattern);
  for await (const path of glob.scan(outputDir)) {
    return join(outputDir, path); // Return full path
  }
  return null;
}

// Check if a bookmark file already has a Replies section
export async function bookmarkHasReplies(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    return false;
  }
  const content = await file.text();
  return content.includes("## Replies");
}

// Check if a bookmark file already has birdmarks-generated YAML frontmatter
// We check for the `id:` field which birdmarks always includes
export async function bookmarkHasFrontmatter(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    return false;
  }
  const content = await file.text();
  if (!content.startsWith("---")) {
    return false;
  }
  // Find the closing --- and check if id: exists in the frontmatter
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return false;
  }
  const frontmatter = content.slice(0, endIndex);
  return frontmatter.includes("\nid:");
}
