# birdmarks

Export your Twitter/X bookmarks to markdown files with full thread expansion, media downloads, article extraction, and optional X bookmark-folder metadata. Note that rate limiting happens pretty quickly with replies, media, and quote tweet nesting, i.e. sometimes I get through around 100 before hitting the rate limit.

## Requirements

- Logged into Twitter/X in Chrome, Safari, or Firefox (for cookie authentication)

## Installation

### Option 1: Download Release (Recommended)

Download the latest release for your platform from the [Releases](https://github.com/gitschwifty/birdmarks/releases) page:

- **macOS Apple Silicon**: `birdmarks-darwin-arm64`
- **macOS Intel**: `birdmarks-darwin-x64`
- **Linux**: `birdmarks-linux-x64`
- **Windows**: `birdmarks-win-x64.exe`

Then make it executable (macOS/Linux):
```bash
chmod +x birdmarks-darwin-arm64
./birdmarks-darwin-arm64 --help
```

**Note:** These binaries aren't signed, so you may need to:
- **macOS**: Right-click → Open, or `xattr -d com.apple.quarantine birdmarks-darwin-*`
- **Windows**: Click "More info" → "Run anyway" on the SmartScreen warning

### Option 2: Build from Source

Requires [Bun](https://bun.sh) runtime (v1.0+):

```bash
git clone https://github.com/gitschwifty/birdmarks.git
cd birdmarks
bun install
bun run build  # Creates ./birdmarks executable
```

## Usage

```bash
# Using compiled binary
./birdmarks

# Or with bun (from source)
bun run src/index.ts

# Export to custom directory
bun run src/index.ts ./my-bookmarks

# Export a single tweet by ID (useful for testing or re-running errors)
bun run src/index.ts --tweet <tweetID>
bun run src/index.ts <tweetID> # auto-detected if all digits

# Include replies from other users (not just the author's thread)
bun run src/index.ts --replies

# Organize bookmarks into yyyy/mm/ subfolders
bun run src/index.ts --date-folders

# Specify browser for cookie source
bun run src/index.ts --cookie-source firefox

# Adjust quote tweet depth (default: 3)
bun run src/index.ts --quote-depth 5

# Rebuild mode: iterate all bookmarks from beginning, skip existing
bun run src/index.ts --rebuild

# Rebuild with reply backfilling (add replies to existing bookmarks that don't have them)
bun run src/index.ts --rebuild --backfill-replies --replies

# Rebuild with frontmatter backfilling (add YAML frontmatter to existing bookmarks)
bun run src/index.ts --rebuild --backfill-frontmatter

# Tag bookmarks with their X bookmark folders (writes folder: "..." in YAML frontmatter)
bun run src/index.ts --with-folders

# Rebuild the folder map from scratch (implies --with-folders)
bun run src/index.ts --refresh-folders

# Re-tag folder: on existing exports without re-fetching tweets
bun run src/index.ts --backfill-folders
```

### Options

| Option | Description |
|--------|-------------|
| `[output-dir]` | Output directory for markdown files (default: `./bookmarks`) |
| `-o, --output <dir>` | Alternative way to specify output directory |
| `-t, --tweet <id>` | Process a single tweet instead of all bookmarks |
| `-n, --max-pages <n>` | Limit pages fetched this run (to avoid rate limits) |
| `-N, --new-first` | Fetch new bookmarks first before resuming from cursor |
| `-d, --date-folders` | Organize bookmarks into `yyyy/mm/` subfolders |
| `-r, --replies` | Include replies from other users (default: off) |
| `-R, --rebuild` | Iterate all bookmarks from beginning (saves cursor for resume) |
| `-B, --backfill-replies` | Backfill missing replies on existing bookmarks (use with `-R -r`) |
| `-F, --backfill-frontmatter` | Add YAML frontmatter to existing bookmarks (use with `-R`) |
| `--with-folders` | Tag bookmarks with their X bookmark folders (adds `folder:` to YAML frontmatter) |
| `--refresh-folders` | Force rebuild of the folder map (implies `--with-folders`) |
| `--backfill-folders` | Re-tag `folder:` on already-exported `.md` files without re-fetching tweets |
| `--quote-depth <n>` | Maximum depth for expanding quoted tweets (default: 3, -1 for unlimited) |
| `--cookie-source <browser>` | Browser to get cookies from: `safari`, `chrome`, `firefox` |
| `-h, --help` | Show help message |

**Note on quote depth:** Using `-1` for unlimited caps at 20 levels deep. If you somehow need more, open an issue or change the cap in `src/index.ts`.

## Output Structure

```
bookmarks/
├── 2024-01-15-username-tweetId.md   # Bookmark markdown files
├── assets/                          # Downloaded images
│   └── abc123.jpg
├── articles/                        # Extracted Twitter articles
│   └── Article-Title.md
├── exporter-state.json              # Resume state (pagination cursor)
├── metadata-cache.json              # Cached link metadata (GitHub, OG tags)
└── errors.json                      # Failed fetches for manual review
```

### Frontmatter

Each bookmark includes YAML frontmatter with metadata:

```yaml
---
id: "2016987515279069403"
author: DanielleFong
author_name: "Danielle Fong 🔆"
date: 2026-01-29
url: https://twitter.com/DanielleFong/status/2016987515279069403
folder: "Claude"  # only present with --with-folders; "unlabeled" when not in any folder
thread_length: 3
reply_count: 15
media_count: 2
quoted_tweet: "2016985000000000000"
hashtags:
  - ClaudeCode
  - AI
links:
  - url: https://github.com/anthropics/claude-code
    type: github
    owner: anthropics
    repo: claude-code
    description: "CLI for Claude"
    stars: 12345
    language: TypeScript
    topics: ["cli", "ai"]
  - url: https://example.com/article
    type: article
    title: "Article Title"
    description: "Meta description"
    site: example.com
---
```

Link metadata is cached locally (`metadata-cache.json`) with a 7-day TTL to avoid redundant API calls.

With `--date-folders` flag, bookmarks are organized by year and month:

```
bookmarks/
├── assets/                          # Shared assets folder
│   └── abc123.jpg
├── articles/
│   └── Article-Title.md
├── 2024/
│   ├── 01/                          # January 2024
│   │   └── 15-username-123.md       # References ../../assets/abc123.jpg
│   └── 02/                          # February 2024
│       └── 03-username-456.md
├── exporter-state.json
└── errors.json
```

## Features

- **Thread expansion** - Always follows the author's reply chain to capture full threads
- **Quote tweets** - Recursively fetches nested quoted tweets
- **Replies** - Optionally captures top-level replies from other users (use `--replies` flag)
- **Media** - Downloads images to local `assets/` folder
- **Articles** - Extracts Twitter articles to `articles/` subfolder with proper formatting in quoted tweets and replies
- **Link resolution** - Expands t.co URLs and fetches page titles
- **YAML frontmatter** - Rich metadata including author, date, hashtags, and link metadata (GitHub stars, OG tags)
- **Hashtag sanitization** - Wraps #hashtags in backticks to prevent Obsidian tag pollution
- **Resume support** - Saves state on rate limit, resume by running again
- **Incremental export** - Skips already-exported bookmarks
- **Single tweet mode** - Process a single tweet by ID for testing or re-running errors
- **Rebuild mode** - Iterate all bookmarks from beginning, optionally backfilling replies or frontmatter on existing bookmarks
- **X bookmark folders** - With `--with-folders`, tag each export with its X folder name in the YAML frontmatter (uses the `BookmarkFoldersSlice` GraphQL endpoint)

## Bookmark Folders

X (Premium) lets you organize bookmarks into folders. With `--with-folders`, birdmarks records which folder each bookmark lives in as `folder: "<name>"` in the YAML frontmatter. Bookmarks not in any folder get `folder: "unlabeled"`.

How it works:

1. On the first `--with-folders` run, birdmarks calls X's `BookmarkFoldersSlice` to enumerate your folders, then paginates each folder via `BookmarkFolderTimeline` to build a `tweetId → folder name` map. The map is persisted to `exporter-state.json` and reused on subsequent runs.
2. During the regular bookmark loop, each bookmark looks up its folder from the map. Articles inherit the folder of the bookmark that referenced them (first-writer-wins if multiple bookmarks reference the same article).
3. Rate-limit hits during the map build save partial progress; the next run resumes from the in-flight folder's cursor.

Refreshing the map:

- The map is **not** auto-refreshed. New folders or bookmark/folder reassignments on X won't be picked up until you pass `--refresh-folders`.
- Run `--backfill-folders` alone to rewrite the `folder:` line on already-exported `.md` files without re-fetching any tweets.

If folder listing breaks (X rotates the GraphQL query ID / feature flags every few weeks), see the header comment in [src/folders-client.ts](src/folders-client.ts) for instructions on grabbing the new values from a logged-in browser session.

Multi-folder tweets: if a bookmark is in multiple folders, the first folder encountered during enumeration wins. Logged at the end of the build pass.

## Rate Limiting

Twitter's API has rate limits. When hit, birdmarks will:
1. Save current progress to `exporter-state.json`
2. Exit cleanly with a message
3. Resume from the same point when you run again

Just wait a few minutes and run the command again to continue.

## Running Tests

```bash
bun test
```

## License

MIT
