# Bookmark Folder Support — Implementation Plan

Draft plan in response to a feature request. **Looking for requester feedback before implementation.**

## Feasibility (confirmed)

`@steipete/bird` v0.7.0 (our current dep) exposes folder-aware bookmark methods on `TwitterClient`:

- `getBookmarkFolderTimeline(folderId, count?, options?)` — single page
- `getAllBookmarkFolderTimeline(folderId, options?)` — full pagination, same shape as `getAllBookmarks`
- `extractBookmarkFolderId(input)` — helper that accepts either a numeric ID or an `https://x.com/i/bookmarks/<id>` URL and returns the ID (or `null` if invalid)

Underlying GraphQL endpoint: `BookmarkFolderTimeline` (query id `KJIQpsvxrTfRIlbaRIySHQ`).

**Limitation:** bird does not expose a "list my folders" endpoint, so users must supply the folder ID/URL manually (grab it from the URL bar at `x.com/i/bookmarks/<id>`). Same UX as the `bird` CLI itself.

## Proposed UX

```bash
# Export a single folder (folder ID or URL accepted)
birdmarks --folder 1234567890123456789
birdmarks --folder https://x.com/i/bookmarks/1234567890123456789

# Output goes into a subdirectory under the output dir, named by folder ID
./bookmarks/folders/1234567890123456789/...
```

### Open question for requester
Per-folder output is the safest default (no collision with the main timeline, separate state, easy to delete/re-run). But people may prefer:
1. **Per-folder subdir** *(recommended)* — `bookmarks/folders/<id>/...`. Clean isolation.
2. **Flat** — same `bookmarks/` dir, just an additional `folder: <id>` field in frontmatter. Tweets that appear in multiple folders end up as a single file.
3. **Folder name from user** — `--folder <id>:<label>` so output goes to `bookmarks/folders/<label>/`. Nicer paths but requires a label.

Leaning toward **(1)** with an optional `--folder-name <label>` to override the directory name. Want input here.

## Implementation steps

### 1. `src/types.ts` — extend config
Add to `ExporterConfig`:
```ts
folderId?: string;       // resolved numeric folder ID
folderName?: string;     // optional user-supplied label for the subdir
```

### 2. `src/index.ts` — CLI wiring
- Add `--folder <id-or-url>` flag.
- Add `--folder-name <label>` flag (optional).
- Use `extractBookmarkFolderId()` from bird to parse — exit with a clear error if invalid.
- Disallow combining `--folder` with `--only-new` / `--new-first` for the first cut (folder phase logic adds complexity; we can revisit). Allow with `--rebuild` though — natural fit.
- Help text + README update.

### 3. `src/exporter.ts` — branch the fetch call
Both `exportBookmarks` and `exportBookmarksRebuild` use `client.getAllBookmarks({ maxPages: 1, cursor })` (3 call sites — lines 423, 610, 907). Wrap in a small helper:

```ts
async function fetchBookmarkPage(
  client: TwitterClient,
  config: ExporterConfig,
  cursor: string | undefined,
) {
  return config.folderId
    ? client.getAllBookmarkFolderTimeline(config.folderId, { maxPages: 1, cursor })
    : client.getAllBookmarks({ maxPages: 1, cursor });
}
```

Replace the 3 call sites. Behavior otherwise identical — bird returns the same `SearchResult` shape for both.

### 4. `src/state.ts` — per-folder state file
State currently lives at `<outputDir>/exporter-state.json`. With per-folder subdirs, the state file naturally moves to `<outputDir>/folders/<id>/exporter-state.json` — no code change needed since the path is derived from `config.outputDir`, which we'll set to the subdir when `folderId` is present.

The `outputDir` rewrite happens once in `src/index.ts` after arg parsing:
```ts
if (folderId) {
  const subdir = folderName ?? folderId;
  outputDir = join(outputDir, "folders", subdir);
  await mkdir(outputDir, { recursive: true });
}
```

This means **no changes to state.ts**. The main timeline's state stays at the original `outputDir`; each folder gets its own cursor, anchor, and errors.json. Switching folders mid-run can't clobber cursors.

### 5. Assets/articles — shared or per-folder?
Current layout: `assets/` and `articles/` live under `outputDir`. With per-folder subdirs, each folder gets its own copies. That's wasteful if the same image appears in both the main timeline and a folder, but it keeps each folder self-contained and avoids cross-folder path resolution headaches.

**Open question:** dedupe by symlinking/sharing the top-level `assets/`? My instinct is *no* for v1 — keep it simple, optimize later if anyone complains.

### 6. Tests
- Unit test: CLI parses `--folder` (URL form and ID form), rejects garbage.
- Unit test: `fetchBookmarkPage` helper picks the right method based on config.
- The fetch helper is small enough that we don't need full integration coverage — the surrounding loop logic is unchanged.

### 7. README + help text
- Add `--folder` and `--folder-name` to the options table.
- Add a "Bookmark Folders" section explaining how to grab the ID from the URL bar.
- Note that folder exports run with their own state/cursor.

## Out of scope (call out for requester)

- **Auto-listing folders** — bird doesn't expose it. Could be done by scraping but not worth it.
- **Multi-folder in one run** — could be added later (loop over `--folder` repeated), but increases complexity. Start with one folder per invocation.
- **Migrating existing exports into a folder subdir** — won't touch existing files. If you want to reorganize, that's manual or a separate `--migrate` mode.

## Estimated size

Small: ~50-80 lines of code change, mostly in `index.ts` (arg parsing) and `exporter.ts` (helper + 3 call site swaps). State/markdown/thread modules unchanged.
