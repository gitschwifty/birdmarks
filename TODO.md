# Future Improvements

## High Priority
- [ ] Rename to `birdmarks`
- [ ] Add `--limit-pages` option for testing without hitting rate limits
- [ ] Add `--dry-run` mode to show what would be exported

## Link Previews
- [ ] Add rich link previews in markdown (Open Graph metadata)
- [ ] Could use format like:
  ```markdown
  > **Title**
  > Description text from meta tags
  > [example.com](https://example.com/article)
  ```
- [ ] Fetch og:title, og:description, og:image from resolved URLs
- [ ] Consider downloading og:image to assets folder

## Media
- [ ] Better video download support (HLS streams via ffmpeg?)
- [ ] Video thumbnail generation
- [ ] Handle Twitter Spaces/audio content

## Organization
- [ ] AI-powered categorization/tagging of bookmarks
- [ ] Generate index.md with all bookmarks grouped by category
- [ ] Support for bookmark folders (bird supports `--folder`)

## Performance
- [ ] Parallel processing of bookmarks (with rate limit awareness)
- [ ] Configurable delays between requests
- [ ] Better progress indicator

## Features
- [ ] Export to other formats (JSON, HTML, Notion)
- [ ] Watch mode - auto-export new bookmarks periodically
- [ ] Filter by date range, author, keywords

## Testing
- [ ] Add more edge case tests (deleted tweets, suspended accounts, etc.)
- [ ] Mock bird client for unit tests without API calls
- [ ] CI integration
