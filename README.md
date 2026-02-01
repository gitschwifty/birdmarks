# birdmarks

Export your Twitter/X bookmarks to markdown files with full thread expansion, media downloads, and article extraction. Note that rate limiting happens pretty quickly with replies, media, and quote tweet nesting, i.e. sometimes I get through around 100 before hitting the rate limit.

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
