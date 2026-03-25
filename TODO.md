# Future Improvements

## High Priority
- [ ] Rename to `birdmarks`
- [ ] Add `--limit-pages` option for testing without hitting rate limits
- [ ] Add `--dry-run` mode to show what would be exported

## `--only-new` Flag Flow

Fetches only new bookmarks (most recent → anchor), never touches the old saved cursor.

### Single pass (no `newPhaseCursor` in state)
1. Fetch from most recent → `previousFirstExported` (the anchor)
2. Update anchor to the newest bookmark seen
3. Done — old cursor untouched

### Two-pass (resuming after rate limit — `newPhaseCursor` exists)
1. **Pass 1 (resume):** `newPhaseCursor` → `previousFirstExported`
   - Records first tweet seen as `pass1FirstSeen`
   - Persists `pass1FirstSeen` to `state.currentRunFirstExported`
   - Clears `newPhaseCursor`
2. **Pass 2 (catch-up):** most recent → `pass1FirstSeen`
   - Skips already-exported bookmarks
   - New anchor = first tweet seen in this pass (the newest overall)

### Rate limit during pass 2
- Saves pass 2 cursor to `newPhaseCursor`
- `state.currentRunFirstExported` already holds `pass1FirstSeen` from after pass 1
- On next run: `originalStopAt` resolves to `pass1FirstSeen`, so recovery
  correctly does pass 1 (cursor → `pass1FirstSeen`) then pass 2 (top → `pass1FirstSeen`)

### State fields used
- `newPhaseCursor` — pagination cursor for resuming within the new-bookmarks phase
- `currentRunFirstExported` — first tweet seen in current run (becomes anchor on finish)
- `previousFirstExported` — anchor from last completed run (the stop point)
- `nextCursor` — old cursor from main export loop (never read or modified by `--only-new`)

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
