import { join } from "path";
import type { BirdmarksTwitterClient } from "./folders-client";
import type { BookmarkFolder, FolderMapBuildState } from "./types";
import { loadState, saveState } from "./state";
import { parseFrontmatter, mergeFrontmatter } from "./markdown";

export const UNLABELED = "unlabeled";

const FOLDER_PAGE_DELAY_MS = 2000;

// Used by callers to surface "rate limit during folder build" the same way
// the bookmark loop surfaces it. The exporter wraps this and triggers
// state-save + clean exit.
export class FolderRateLimitError extends Error {
  constructor(context: string) {
    super(`Rate limited during ${context}`);
    this.name = "FolderRateLimitError";
  }
}

function isRateLimitError(error: unknown): boolean {
  const m = error instanceof Error ? error.message : String(error);
  return m.includes("rate") || m.includes("429") || m.includes("Too Many");
}

// Return the folder a tweet belongs to, or "unlabeled" if not found / no map.
// The map is name-at-fetch-time; if you rename a folder on X, this returns
// the old name until you --refresh-folders.
export function getFolderForTweet(
  map: Record<string, string> | undefined,
  tweetId: string
): string {
  if (!map) return UNLABELED;
  return map[tweetId] ?? UNLABELED;
}

// Build a tweetId → folder name map by enumerating folders and paginating
// each one's timeline. Resume-safe: persists partial state to
// `state.folderMapBuildState` so a rate-limit hit lets the next run skip
// already-done folders and pick up the in-flight folder's cursor.
//
// Multi-folder tweets: first folder wins (we iterate folders in the order
// BookmarkFoldersSlice returns them, which is roughly creation order on X).
// To change which folder "wins", reorder the folder list before calling.
export async function buildFolderMap(
  client: BirdmarksTwitterClient,
  outputDir: string,
  options: { refresh?: boolean } = {}
): Promise<Record<string, string>> {
  let state = await loadState(outputDir);

  // Skip if we have a complete map and not asked to refresh.
  if (!options.refresh && state.folderMap && !state.folderMapBuildState) {
    console.log(
      `Folder map: reusing ${Object.keys(state.folderMap).length} entries from ${state.folderMapBuiltAt ?? "previous run"}.`
    );
    return state.folderMap;
  }

  if (options.refresh) {
    console.log("Folder map: --refresh-folders set, rebuilding from scratch.");
    state.folderMap = undefined;
    state.folderMapBuiltAt = undefined;
    state.folderMapBuildState = undefined;
    await saveState(outputDir, state);
  }

  console.log("Building bookmark folder map...");

  // 1. List all folders
  let folders: BookmarkFolder[];
  try {
    folders = await client.getBookmarkFolders();
  } catch (error) {
    if (isRateLimitError(error)) {
      throw new FolderRateLimitError("listing bookmark folders");
    }
    throw error;
  }

  if (folders.length === 0) {
    console.log(
      "No bookmark folders found. (Possible reasons: no Premium, no folders created, or query ID/features rotated — see src/folders-client.ts header.)"
    );
    // Persist an empty map so we don't probe every run.
    const empty: Record<string, string> = {};
    state.folderMap = empty;
    state.folderMapBuiltAt = new Date().toISOString();
    state.folderMapBuildState = undefined;
    await saveState(outputDir, state);
    return empty;
  }

  console.log(`Found ${folders.length} folder(s): ${folders.map((f) => f.name).join(", ")}`);

  // 2. Resume any in-progress build, or start fresh.
  const buildState: FolderMapBuildState = state.folderMapBuildState ?? { doneIds: [] };
  const map: Record<string, string> = { ...(state.folderMap ?? {}) };
  let multiFolderCount = 0;

  if (state.folderMapBuildState) {
    console.log(
      `Resuming partial folder build (${buildState.doneIds.length}/${folders.length} folders complete).`
    );
  }

  // 3. Iterate folders, paginating each one. Persist progress after each page.
  for (const folder of folders) {
    if (buildState.doneIds.includes(folder.id)) continue;

    // Cursor: resume if this folder is the in-flight one
    let cursor: string | undefined =
      buildState.inFlight?.id === folder.id ? buildState.inFlight.cursor : undefined;

    console.log(`Fetching folder "${folder.name}" (${folder.id})${cursor ? " resuming" : ""}...`);
    let pageNum = 0;
    while (true) {
      pageNum++;
      buildState.inFlight = { id: folder.id, cursor };
      state.folderMapBuildState = buildState;
      await saveState(outputDir, state);

      let pageTweets: { id: string }[];
      let nextCursor: string | undefined;
      try {
        const result = await client.getAllBookmarkFolderTimeline(folder.id, {
          maxPages: 1,
          cursor,
        });
        if (!result.success) {
          throw new Error(result.error || "fetch failed");
        }
        pageTweets = result.tweets;
        nextCursor = result.nextCursor;
      } catch (error) {
        if (isRateLimitError(error)) {
          // Persist partial state including in-flight cursor
          state.folderMapBuildState = buildState;
          state.folderMap = map;
          await saveState(outputDir, state);
          throw new FolderRateLimitError(`folder "${folder.name}" page ${pageNum}`);
        }
        console.warn(`  Folder "${folder.name}" page ${pageNum} failed: ${error}`);
        // Move on — fail open, this folder is partially mapped. Don't mark
        // it as done since we might want to retry on --refresh-folders.
        break;
      }

      for (const tweet of pageTweets) {
        if (map[tweet.id]) {
          // Already mapped → tweet is in multiple folders. First wins.
          multiFolderCount++;
          continue;
        }
        map[tweet.id] = folder.name;
      }

      console.log(`  Page ${pageNum}: ${pageTweets.length} tweets`);

      if (!nextCursor) break;
      cursor = nextCursor;
      await sleep(FOLDER_PAGE_DELAY_MS);
    }

    buildState.doneIds.push(folder.id);
    buildState.inFlight = undefined;
    state.folderMapBuildState = buildState;
    state.folderMap = map;
    await saveState(outputDir, state);
  }

  // 4. Mark complete
  state.folderMap = map;
  state.folderMapBuiltAt = new Date().toISOString();
  state.folderMapBuildState = undefined;
  await saveState(outputDir, state);

  console.log(
    `Folder map complete: ${Object.keys(map).length} tweets across ${folders.length} folder(s)` +
      (multiFolderCount > 0
        ? ` (${multiFolderCount} tweet(s) in multiple folders — first folder kept)`
        : "")
  );

  return map;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Iterate over .md files in outputDir, parse the tweet ID from each filename,
// look up the folder, and update only the `folder:` line in frontmatter.
// Does not fetch from the network. Caller must build the map first.
//
// Also scans each bookmark for [Read full article](articles/<slug>.md)
// references and propagates the bookmark's folder to those article files.
// Used by --backfill-folders.
export interface BackfillStats {
  scanned: number;
  taggedBookmarks: number;
  unlabeledBookmarks: number;
  noFrontmatter: number;
  taggedArticles: number;
  conflictedArticles: number;
}

export async function backfillFolderField(
  outputDir: string,
  map: Record<string, string>,
  options: { useDateFolders?: boolean } = {}
): Promise<BackfillStats> {
  const pattern = options.useDateFolders ? "**/*.md" : "*.md";
  const counts: BackfillStats = {
    scanned: 0,
    taggedBookmarks: 0,
    unlabeledBookmarks: 0,
    noFrontmatter: 0,
    taggedArticles: 0,
    conflictedArticles: 0,
  };

  const tweetIdRegex = /-(\d{15,25})\.md$/;
  const articleLinkRegex = /\]\(articles\/([^)]+\.md)\)/g;
  const articleFolderAssigned = new Map<string, string>(); // article path → folder (first writer wins)

  const glob = new Bun.Glob(pattern);

  for await (const relPath of glob.scan(outputDir)) {
    // Skip articles dir; we tag those in a second pass below
    if (relPath.startsWith("articles/") || relPath.startsWith("articles\\")) continue;

    counts.scanned++;
    const m = tweetIdRegex.exec(relPath);
    if (!m) continue;
    const tweetId = m[1]!;
    const folder = map[tweetId] ?? UNLABELED;

    const filepath = join(outputDir, relPath);
    const file = Bun.file(filepath);
    const content = await file.text();
    const { frontmatter: existing, body } = parseFrontmatter(content);

    if (!existing) {
      counts.noFrontmatter++;
      continue;
    }

    // Track which articles this bookmark refers to, so we can tag them later
    for (const am of body.matchAll(articleLinkRegex)) {
      const articleRel = `articles/${am[1]!}`;
      if (!articleFolderAssigned.has(articleRel)) {
        articleFolderAssigned.set(articleRel, folder);
      } else if (articleFolderAssigned.get(articleRel) !== folder) {
        counts.conflictedArticles++;
      }
    }

    // Only rewrite the bookmark if the folder is missing or different
    if (existing.folder !== folder) {
      const synthetic = `---\nfolder: "${folder}"\n---\n`;
      const newFrontmatter = mergeFrontmatter({ ...existing, folder }, synthetic);
      await Bun.write(filepath, newFrontmatter + body);
    }

    if (folder === UNLABELED) counts.unlabeledBookmarks++;
    else counts.taggedBookmarks++;
  }

  // Second pass: tag articles based on the bookmark→article map collected above.
  for (const [articleRel, folder] of articleFolderAssigned) {
    const articlePath = join(outputDir, articleRel);
    const f = Bun.file(articlePath);
    if (!(await f.exists())) continue;
    const content = await f.text();
    const { frontmatter: existing, body } = parseFrontmatter(content);

    if (existing && existing.folder === folder) {
      counts.taggedArticles++;
      continue;
    }

    // Articles may not have any frontmatter yet — synthesize a minimal block
    const baseFm: Record<string, unknown> = existing ?? {};
    baseFm.folder = folder;
    const synthetic = `---\nfolder: "${folder}"\n---\n`;
    const newFrontmatter = mergeFrontmatter(baseFm, synthetic);
    await Bun.write(articlePath, newFrontmatter + body);
    counts.taggedArticles++;
  }

  return counts;
}
