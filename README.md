# birdmarks

Export your Twitter/X bookmarks to markdown files with full thread expansion, media downloads, and article extraction.

## Requirements

- [Bun](https://bun.sh) runtime (v1.0+)
- [bird](https://github.com/steipete/bird) CLI installed (`bun add -g @steipete/bird`)
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
| `--quote-depth <n>` | Maximum depth for expanding quoted tweets (default: 3) |
| `--cookie-source <browser>` | Browser to get cookies from: `safari`, `chrome`, `firefox` |
| `-h, --help` | Show help message |

## Output Structure

```
bookmarks/
├── 2024-01-15-username-first-words-of-tweet.md   # Bookmark markdown files
├── assets/                                        # Downloaded images
│   └── abc123.jpg
├── articles/                                      # Extracted Twitter articles
│   └── Article-Title.md
├── exporter-state.json                           # Resume state (pagination cursor)
└── errors.json                                   # Failed fetches for manual review
```

## Features

- **Thread expansion** - Follows author's reply chain to capture full threads
- **Quote tweets** - Recursively fetches nested quoted tweets
- **Replies** - Captures top-level replies to bookmarked tweets
- **Media** - Downloads images to local `assets/` folder
- **Articles** - Extracts Twitter articles to `articles/` subfolder
- **Link resolution** - Expands t.co URLs and fetches page titles
- **Resume support** - Saves state on rate limit, resume by running again
- **Incremental export** - Skips already-exported bookmarks

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
