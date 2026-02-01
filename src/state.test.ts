import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { loadState, saveState, finishRun, bookmarkHasFrontmatter } from "./state";
import type { ExporterState } from "./types";

describe("state", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "birdmarks-state-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("loadState and saveState", () => {
    test("returns empty state for new directory", async () => {
      const state = await loadState(tempDir);
      expect(state).toEqual({});
    });

    test("saves and loads state", async () => {
      const state: ExporterState = {
        nextCursor: "abc123",
        currentPage: 5,
        previousFirstExported: "tweet123",
      };

      await saveState(tempDir, state);
      const loaded = await loadState(tempDir);

      expect(loaded).toEqual(state);
    });

    test("persists state to file", async () => {
      await saveState(tempDir, { nextCursor: "test" });

      const file = Bun.file(join(tempDir, "exporter-state.json"));
      expect(await file.exists()).toBe(true);

      const content = await file.json();
      expect(content.nextCursor).toBe("test");
    });
  });

  describe("finishRun", () => {
    test("clears pagination state", async () => {
      await saveState(tempDir, {
        nextCursor: "cursor123",
        currentPageBookmarks: [{ id: "1" }] as any,
        currentPage: 10,
        previousFirstExported: "keep-this",
      });

      await finishRun(tempDir);
      const state = await loadState(tempDir);

      expect(state.nextCursor).toBeUndefined();
      expect(state.currentPageBookmarks).toBeUndefined();
      expect(state.currentPage).toBeUndefined();
      expect(state.previousFirstExported).toBe("keep-this");
    });

    test("promotes currentRunFirstExported to previousFirstExported", async () => {
      await saveState(tempDir, {
        currentRunFirstExported: "new-first",
        previousFirstExported: "old-first",
      });

      await finishRun(tempDir);
      const state = await loadState(tempDir);

      expect(state.previousFirstExported).toBe("new-first");
      expect(state.currentRunFirstExported).toBeUndefined();
    });

    test("sets completion flags when completedFullScan is true", async () => {
      await saveState(tempDir, {});

      const beforeTime = new Date().toISOString();
      await finishRun(tempDir, { completedFullScan: true });
      const afterTime = new Date().toISOString();

      const state = await loadState(tempDir);

      expect(state.allBookmarksProcessed).toBe(true);
      expect(state.lastFullScanAt).toBeDefined();
      // Check timestamp is reasonable
      expect(state.lastFullScanAt! >= beforeTime).toBe(true);
      expect(state.lastFullScanAt! <= afterTime).toBe(true);
    });

    test("does not set completion flags when completedFullScan is false", async () => {
      await saveState(tempDir, {});

      await finishRun(tempDir, { completedFullScan: false });
      const state = await loadState(tempDir);

      expect(state.allBookmarksProcessed).toBeUndefined();
      expect(state.lastFullScanAt).toBeUndefined();
    });

    test("does not set completion flags when options not provided", async () => {
      await saveState(tempDir, {});

      await finishRun(tempDir);
      const state = await loadState(tempDir);

      expect(state.allBookmarksProcessed).toBeUndefined();
      expect(state.lastFullScanAt).toBeUndefined();
    });

    test("preserves existing completion state when not completing full scan", async () => {
      await saveState(tempDir, {
        allBookmarksProcessed: true,
        lastFullScanAt: "2026-01-01T00:00:00.000Z",
      });

      await finishRun(tempDir);
      const state = await loadState(tempDir);

      // Previous completion state should be preserved
      expect(state.allBookmarksProcessed).toBe(true);
      expect(state.lastFullScanAt).toBe("2026-01-01T00:00:00.000Z");
    });

    test("updates completion state on new full scan", async () => {
      await saveState(tempDir, {
        allBookmarksProcessed: true,
        lastFullScanAt: "2026-01-01T00:00:00.000Z",
      });

      await finishRun(tempDir, { completedFullScan: true });
      const state = await loadState(tempDir);

      expect(state.allBookmarksProcessed).toBe(true);
      // Timestamp should be updated
      expect(state.lastFullScanAt).not.toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("bookmarkHasFrontmatter", () => {
    test("returns true for birdmarks-generated frontmatter with id field", async () => {
      const filepath = join(tempDir, "test.md");
      await Bun.write(filepath, `---
id: "123456789"
author: testuser
---
# Thread

Content here`);

      expect(await bookmarkHasFrontmatter(filepath)).toBe(true);
    });

    test("returns false for frontmatter without id field", async () => {
      const filepath = join(tempDir, "test.md");
      await Bun.write(filepath, `---
title: "Some Title"
tags: [tag1, tag2]
---
# Thread

Content here`);

      expect(await bookmarkHasFrontmatter(filepath)).toBe(false);
    });

    test("returns false for content without frontmatter", async () => {
      const filepath = join(tempDir, "test.md");
      await Bun.write(filepath, `# Thread

**@testuser** (Test User)

Content here`);

      expect(await bookmarkHasFrontmatter(filepath)).toBe(false);
    });

    test("returns false for non-existent file", async () => {
      const filepath = join(tempDir, "nonexistent.md");
      expect(await bookmarkHasFrontmatter(filepath)).toBe(false);
    });

    test("returns false for malformed frontmatter (no closing ---)", async () => {
      const filepath = join(tempDir, "test.md");
      await Bun.write(filepath, `---
id: "123456789"
author: testuser
Content without closing frontmatter`);

      expect(await bookmarkHasFrontmatter(filepath)).toBe(false);
    });
  });
});
