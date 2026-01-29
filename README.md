# birdmarks

Export your Twitter/X bookmarks to markdown files with full thread expansion, media downloads, and article extraction. Note that rate limiting happens pretty quickly with replies, media, and quote tweet nesting, i.e. sometimes I get through around 100 before hitting the rate limit.

## Requirements

- [Bun](https://bun.sh) runtime (v1.0+)
- [bird](https://github.com/steipete/bird) CLI installed (`bun add -g @steipete/bird`) (technically not required but easier to test auth with this)
- Logged into Twitter/X in Chrome, Safari, or Firefox (for cookie authentication)

## Installation

```bash
git clone https://github.com/yourusername/birdmarks.git
cd birdmarks
bun install
```

## Usage

```bash
# Export to default ./bookmarks directory
bun run src/index.ts

# Export to custom directory
bun run src/index.ts ./my-bookmarks

# Export a single tweet by ID (useful for testing or re-running errors)
bun run src/index.ts --tweet <tweetID>
bun run src/index.ts <tweetID> # auto-detected if all digits

# Include replies from other users (not just the author's thread)
bun run src/index.ts --replies

# Organize bookmarks into yyyy-mm subfolders
bun run src/index.ts --date-folders

# Specify browser for cookie source
bun run src/index.ts --cookie-source firefox

# Adjust quote tweet depth (default: 3)
bun run src/index.ts --quote-depth 5
```

### Options

| Option | Description |
|--------|-------------|
| `[output-dir]` | Output directory for markdown files (default: `./bookmarks`) |
| `-o, --output <dir>` | Alternative way to specify output directory |
| `-t, --tweet <id>` | Process a single tweet instead of all bookmarks |
| `-n, --max-pages <n>` | Limit pages fetched this run (to avoid rate limits) |
| `-N, --new-first` | Fetch new bookmarks first before resuming from cursor |
| `-d, --date-folders` | Organize bookmarks into `yyyy-mm/` subfolders |
| `-r, --replies` | Include replies from other users (default: off) |
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
└── errors.json                      # Failed fetches for manual review
```

With `--date-folders` flag, bookmarks are organized by month:

```
bookmarks/
├── assets/                          # Shared assets folder
│   └── abc123.jpg
├── articles/
│   └── Article-Title.md
├── 2024-01/                         # Bookmarks from January 2024
│   └── 2024-01-15-username-123.md   # References ../assets/abc123.jpg
├── 2024-02/                         # Bookmarks from February 2024
│   └── 2024-02-03-username-456.md
├── exporter-state.json
└── errors.json
```

## Features

- **Thread expansion** - Always follows the author's reply chain to capture full threads
- **Quote tweets** - Recursively fetches nested quoted tweets
- **Replies** - Optionally captures top-level replies from other users (use `--replies` flag)
- **Media** - Downloads images to local `assets/` folder
- **Articles** - Extracts Twitter articles to `articles/` subfolder
- **Link resolution** - Expands t.co URLs and fetches page titles
- **Resume support** - Saves state on rate limit, resume by running again
- **Incremental export** - Skips already-exported bookmarks
- **Single tweet mode** - Process a single tweet by ID for testing or re-running errors

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
