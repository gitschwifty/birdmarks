# Fork: X bookmark folder support — merge proposal

Audience: birdmarks upstream maintainer (and their LLM code-review agent). This document is intentionally self-contained: file paths, what changed, why, what's known to work, what isn't tested. Skim §1 first; everything else is reference.

## 1. TL;DR

This fork adds optional support for X's bookmark folders. With a new `--with-folders` flag, each exported bookmark gets a `folder: "<name>"` field in its YAML frontmatter, sourced from X's `BookmarkFoldersSlice` and `BookmarkFolderTimeline` GraphQL endpoints.

**Default behavior is unchanged.** No new flags = byte-identical output to upstream. The integration is additive: new files plus opt-in branches in existing code, gated by `config.withFolders`. Zero changes to the existing pagination, rate-limit, or resume logic in any non-folder code path.

Tested end-to-end against a real X account with 20 folders; folder listing, map build, and bookmark export all succeed. Full long-running export with rate-limit-driven resume across the folder-map build is structurally correct but hasn't been exercised at scale yet (see §7).

## 2. Motivation

Upstream birdmarks exports every bookmark beautifully but doesn't know about folders. For users on X Premium who organize bookmarks into folders, that's the only piece of metadata that gets lost. The downstream use case here: pushing exports to a Notion database with a `Folder` select property; without folder info, every bookmark lands in `unlabeled` and has to be manually triaged.

Before this fork: my workflow was birdmarks → a Python script (`tag-folders.py`) that read DOM-scraped `<folder>.txt` files (a browser-side JS scraper I ran manually with mutation-observer hooks while scrolling each folder on x.com). Fragile and manual. This fork replaces that by calling the GraphQL endpoints birdmarks already authenticates against.

## 3. What's new

### New CLI flags

| Flag | Effect |
|---|---|
| `--with-folders` | Build/reuse a `tweetId → folder name` map; tag each exported bookmark with `folder: "<name>"` in YAML frontmatter. Bookmarks not in any folder get `folder: "unlabeled"`. |
| `--refresh-folders` | Force-rebuild the folder map (implies `--with-folders`). Otherwise the map is reused indefinitely from `exporter-state.json`. |
| `--backfill-folders` | Standalone mode: build the folder map, then rewrite the `folder:` line on already-exported `.md` files without re-fetching any tweets. |

### New frontmatter field

```yaml
---
id: "2016987515279069403"
author: DanielleFong
...
folder: "Claude"      # only when --with-folders is active; "unlabeled" if not in a folder
...
---
```

Articles inherit the folder of the parent bookmark that referenced them (first writer wins if multiple bookmarks reference the same article).

### New files

| Path | Role | Approx LoC |
|---|---|---|
| [`src/folders-client.ts`](src/folders-client.ts) | `BirdmarksTwitterClient extends TwitterClient` — adds `getBookmarkFolders()` for the `BookmarkFoldersSlice` endpoint, plus a `getBookmarkFoldersRaw()` for debugging. Owns the queryId constant + features-JSON snapshot. | ~180 |
| [`src/folders.ts`](src/folders.ts) | Orchestration: `buildFolderMap()`, `getFolderForTweet()`, `backfillFolderField()`. Handles per-folder pagination, partial-state persistence, multi-folder dedup. | ~250 |
| [`scripts/verify-folders.ts`](scripts/verify-folders.ts) | Standalone one-shot verifier — calls `getCurrentUser()` then `getBookmarkFolders()`, prints results. Reads tokens from `.env`. Used during initial bring-up; runs under node 24+ or bun. | ~140 |

### Modified files (all changes gated by `config.withFolders`)

| Path | Changes |
|---|---|
| [`src/types.ts`](src/types.ts) | Added `BookmarkFolder`, `FolderMapBuildState`; extended `ExporterConfig` with `withFolders`/`refreshFolders`/`backfillFolders`; extended `ExporterState` with `folderMap`/`folderMapBuiltAt`/`folderMapBuildState`; extended `BookmarkFrontmatter` with optional `folder`. |
| [`src/markdown.ts`](src/markdown.ts) | `generateFrontmatter()` accepts optional `folder` and emits `folder: "..."`. `writeBookmarkMarkdown()` / `writeArticleFromTweet()` / `generateArticleMarkdown()` / `extractArticlesFromTweet()` all gain an optional `folder` parameter that's threaded through. Added `"folder"` to the YAML key-ordering list. |
| [`src/exporter.ts`](src/exporter.ts) | At the top of `exportBookmarks()` and `exportBookmarksRebuild()`, if `config.withFolders`, call `buildFolderMap()` before any bookmark fetching. Pass the per-bookmark folder lookup into every `writeBookmarkMarkdown` and `writeArticleFromTweet` call. Added `backfillFolders()` entry point for the standalone backfill mode. |
| [`src/index.ts`](src/index.ts) | Parse new flags; instantiate `BirdmarksTwitterClient` (the subclass) instead of `TwitterClient`; dispatch the backfill-folders mode before regular export; surface the new counter in run-end summary. |
| [`README.md`](README.md) | Fork note at top, install warning that upstream binaries lack folder support, new flag docs, "Bookmark Folders" section, frontmatter example updated. |
| [`.gitignore`](.gitignore) | Standard additions (`.env`, macOS `._*`). |

## 4. Why the subclass approach (not a bird fork)

`BookmarkFolderTimeline` is already exposed by bird as `getAllBookmarkFolderTimeline(folderId, opts)`. But there's no method to **list** folders — `BookmarkFoldersSlice` isn't in `FALLBACK_QUERY_IDS` or `TARGET_QUERY_ID_OPERATIONS`. We considered three options:

1. **Fork bird, add the mixin.** Cleanest abstraction, but bird's GitHub repo is now private and the npm package is marked deprecated — there's no upstream PR target. Forking would mean patching compiled `dist/` JS or vendoring the tarball. Net: high maintenance cost for marginal cleanliness gain.
2. **Hand-roll a raw `fetch()` in birdmarks.** Avoids touching bird, but requires duplicating bird's header / transaction-ID / cookie-jar construction. Fragile — any drift causes cryptic auth failures.
3. **Subclass `TwitterClient` in birdmarks.** ← chosen

`TwitterClient` is exported as a regular class, and `TwitterClientBase` exposes `getHeaders()`, `fetchWithTimeout()`, `createTransactionId()`, `getJsonHeaders()` as `protected`. A subclass defined inside birdmarks can call them via normal inheritance — no header duplication, no fork. The only things we own ourselves are:

- `BOOKMARK_FOLDERS_QUERY_ID` (one string constant)
- `BOOKMARK_FOLDERS_FEATURES` (one feature-flag object, derived from bird's `buildBookmarksFeatures()`)
- A structural extractor (`extractFoldersFromResponse`) that walks the parsed response looking for folder-shaped objects rather than hardcoding the path

That last point is worth highlighting: I initially hardcoded `data.viewer.bookmark_collections_slice.items` and it returned empty against a real account. Switching to structural extraction (find objects with snowflake-shaped IDs + a name field, filter out anything that looks like a user) found all 20 folders and is robust to response-shape rotation.

## 5. Backward compatibility

Every change is gated by `config.withFolders === true`:

- `generateFrontmatter(bookmark, links)` continues to work (3rd arg is optional `folder?: string`).
- `writeBookmarkMarkdown(bookmark, outDir, options)` continues to work (added `folder?` to the existing options bag).
- `writeArticleFromTweet(tweet, outDir)` continues to work (added optional `folder?` 3rd arg).
- `exportBookmarks(client, config)` continues to work — the folder-map build only runs if `config.withFolders` is true; otherwise the function is byte-identical to upstream.
- `BirdmarksTwitterClient` is a `TwitterClient` (extends, doesn't replace). Existing callers that type as `TwitterClient` keep working.

No removed flags, no renamed fields, no changed defaults. Running upstream commands produces upstream output.

State-file additions (`folderMap`, `folderMapBuiltAt`, `folderMapBuildState`) are also opt-in: they're only written when `--with-folders` runs. An existing state file from upstream is forward-compatible.

## 6. The fragile bit: GraphQL query IDs and feature flags

X rotates GraphQL query IDs and feature flags every few weeks. Upstream bird handles this for the endpoints it knows about via `bird query-ids --fresh` (which scrapes the X web bundle for new IDs) and a feature-override cache. Neither system knows about `BookmarkFoldersSlice`.

For this fork:

- **queryId**: hardcoded in `src/folders-client.ts` as `BOOKMARK_FOLDERS_QUERY_ID`. Current value: `i78YDd0Tza-dV4SYs58kRg` (verified working against live X). When it rotates, update one constant in one file. Instructions for refreshing are in the file header — they amount to "open DevTools on x.com/i/bookmarks, find the BookmarkFoldersSlice request, copy the URL segment before the operation name."
- **features**: also in `src/folders-client.ts` as `BOOKMARK_FOLDERS_FEATURES`. Derived from bird's `buildBookmarksFeatures()` because X's web client appears to send the same feature set across the three bookmark-related operations. Currently working; if X rejects a future feature set the error message is descriptive ("the following features cannot be null: …") and the recovery is the same DevTools inspection.
- **response shape**: not hardcoded. `extractFoldersFromResponse()` walks the tree structurally, so minor shape rotations are absorbed without code changes. If X restructures heavily, the `scripts/verify-folders.ts` script has a fallback path that dumps the raw response when extraction returns empty, making the fix obvious.

If you don't want to take on this maintenance burden, the alternative is to **gate this feature behind a separate package or feature-flag** so users opting in accept the rotation risk explicitly.

## 7. What's tested

- **Type checking**: `npx tsc --noEmit` is clean.
- **Folder listing**: Verified against live X (account with 20 folders, mixed-script names including Japanese characters like `健康`, `光`, `バンガー`). All folders correctly listed with their snowflake IDs.
- **Single-page export with folders**: `--with-folders --max-pages 1` builds the folder map across all 20 folders, then exports 20 bookmarks with correct `folder:` tags. End-to-end works.
- **Frontmatter parsing**: Existing tests pass (unchanged).

Not yet exercised:
- Long-running export that triggers rate-limit during the folder-map build (state-save logic is wired the same way as the bookmark loop, but it hasn't actually been hit yet at scale).
- Multi-folder tweets — my account doesn't have any, so the "first folder wins" branch is logic-only verified.
- `--backfill-folders` on a populated directory.
- `--refresh-folders` round-trip.

I haven't added unit tests for the new code yet. If you'd want this for upstream merge, the test gaps that matter most are:
1. `extractFoldersFromResponse()` against a captured response fixture.
2. `buildFolderMap()` resume after partial state.
3. `backfillFolderField()` against a fixture directory.

I can add these before a PR.

## 8. Decisions and what's NOT in scope

- **Folder rename support**: not supported. The map stores name-at-fetch-time. If a folder is renamed on X, the old name persists until `--refresh-folders`. My account doesn't do renames; trade-off felt acceptable for v1.
- **Automatic map refresh**: no TTL, no auto-refresh. Map is reused indefinitely until `--refresh-folders` is passed. Cheap, predictable.
- **Multi-folder tweets**: first folder encountered wins, in `BookmarkFoldersSlice` iteration order. Logged at end of build pass ("N tweets in multiple folders, first kept"). If you'd want stable ordering or a "primary folder" flag, that's a follow-up.
- **Folder field always present**: when `--with-folders` is on, every bookmark gets a `folder:` (possibly `"unlabeled"`). The downstream Notion pipeline I use depends on this; making it conditional would push complexity to consumers.
- **No CLI flag for folder ID filtering**: there's no `--only-folder X` or `--exclude-folder Y`. Easy to add if requested; just wasn't needed for the use case driving this fork.

## 9. Open questions for a maintainer review

1. **Maintenance burden acceptable?** §6 covers what you'd own. If "no", we could gate the feature with a runtime warning ("experimental — may break when X rotates schema").
2. **Frontmatter key ordering**: I put `folder:` between `url:` and `thread_length:`. Open to reordering.
3. **State-file schema**: I added three new fields. Old state files load fine (everything's optional). If you want stricter migration semantics, happy to add.
4. **Naming**: `--with-folders` was chosen over `--folders` because the codebase already uses "folders" for the `--date-folders` filesystem concept. Reasonable, or rename?
5. **Subclass approach vs proper mixin**: I chose subclassing to avoid touching bird. If you'd prefer a proper bird-side mixin (and want to take ownership of patching bird), the migration is mechanical.

---

## Appendix: code review entry points for an LLM

Read in this order:

1. [`src/folders-client.ts`](src/folders-client.ts) — the only file that talks to X's GraphQL. Self-contained, well-commented header.
2. [`src/folders.ts`](src/folders.ts) — the orchestration layer above the client. `buildFolderMap()` is the most complex function; everything else is straightforward.
3. [`src/exporter.ts`](src/exporter.ts) — search for `withFolders`, `folderMap`, `getFolderForTweet`, `FolderRateLimitError` to see every integration point. Each one is gated and additive.
4. [`src/markdown.ts`](src/markdown.ts) — diff against upstream is minimal: optional `folder` parameter threaded through, one new key in the ordered-keys list.

For a quick sanity check, [`scripts/verify-folders.ts`](scripts/verify-folders.ts) is runnable standalone (`node --env-file=.env scripts/verify-folders.ts`) and exercises only the folder-listing path.
