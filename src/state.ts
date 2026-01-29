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

export async function finishRun(outputDir: string): Promise<void> {
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
      // Obsidian: # (tags/headings), | (alias), [] (links), ^ (block refs), () (annoying), ! (embeds)
      .replace(/[<>:"/\\|?*#\[\]^()!]/g, "")
      // Replace spaces and multiple dashes with single dash
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      // Remove leading/trailing dashes and dots
      .replace(/^[-.]+|[-.]+$/g, "")
  );
}

export function bookmarkFilename(tweet: {
  id: string;
  createdAt?: string;
  author: { username: string };
}): string {
  // Format: yyyy-mm-dd-handle-id.md
  let datePart = "unknown-date";
  if (tweet.createdAt) {
    const date = new Date(tweet.createdAt);
    datePart = date.toISOString().split("T")[0] ?? "unknown-date"; // yyyy-mm-dd
  }
  const safeUsername = sanitizeFilename(tweet.author.username);
  return `${datePart}-${safeUsername}-${tweet.id}.md`;
}

export async function bookmarkExists(
  outputDir: string,
  tweet: { id: string; createdAt?: string; author: { username: string } }
): Promise<boolean> {
  const filename = bookmarkFilename(tweet);
  const filepath = join(outputDir, filename);
  return await Bun.file(filepath).exists();
}

// Check if bookmark exists by date + tweet ID (handles username changes, fast lookup)
export async function bookmarkExistsById(
  outputDir: string,
  tweetId: string,
  createdAt?: string
): Promise<boolean> {
  // Use date prefix to narrow search if available
  let pattern: string;
  if (createdAt) {
    const date = new Date(createdAt);
    const datePart = date.toISOString().split("T")[0] ?? "unknown-date";
    pattern = `${datePart}-*-${tweetId}.md`;
  } else {
    pattern = `*-${tweetId}.md`;
  }

  const glob = new Bun.Glob(pattern);
  for await (const _ of glob.scan(outputDir)) {
    return true; // Found at least one match
  }
  return false;
}
