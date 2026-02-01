import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { getCachedMetadata, cacheMetadata, getMetadataWithCache } from "./metadata-cache";
import type { LinkMetadata } from "./types";

describe("metadata-cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "birdmarks-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("cacheMetadata and getCachedMetadata", () => {
    test("stores and retrieves metadata", async () => {
      const metadata: LinkMetadata = {
        url: "https://github.com/test/repo",
        type: "github",
        owner: "test",
        repo: "repo",
        stars: 100,
      };

      await cacheMetadata(tempDir, "https://github.com/test/repo", metadata);
      const retrieved = await getCachedMetadata(tempDir, "https://github.com/test/repo");

      expect(retrieved).toEqual(metadata);
    });

    test("returns null for uncached URL", async () => {
      const result = await getCachedMetadata(tempDir, "https://not-cached.com");
      expect(result).toBeNull();
    });

    test("stores multiple URLs", async () => {
      const metadata1: LinkMetadata = { url: "https://a.com", type: "article" };
      const metadata2: LinkMetadata = { url: "https://b.com", type: "youtube" };

      await cacheMetadata(tempDir, "https://a.com", metadata1);
      await cacheMetadata(tempDir, "https://b.com", metadata2);

      expect(await getCachedMetadata(tempDir, "https://a.com")).toEqual(metadata1);
      expect(await getCachedMetadata(tempDir, "https://b.com")).toEqual(metadata2);
    });

    test("persists to disk", async () => {
      const metadata: LinkMetadata = { url: "https://test.com", type: "article" };
      await cacheMetadata(tempDir, "https://test.com", metadata);

      // Check file exists
      const cacheFile = Bun.file(join(tempDir, "metadata-cache.json"));
      expect(await cacheFile.exists()).toBe(true);

      // Check file content
      const content = await cacheFile.json();
      expect(content["https://test.com"]).toBeDefined();
      expect(content["https://test.com"].metadata).toEqual(metadata);
      expect(content["https://test.com"].fetchedAt).toBeDefined();
    });
  });

  describe("getMetadataWithCache", () => {
    test("returns cached value without calling fetcher", async () => {
      const metadata: LinkMetadata = { url: "https://cached.com", type: "article", title: "Cached" };
      await cacheMetadata(tempDir, "https://cached.com", metadata);

      let fetcherCalled = false;
      const result = await getMetadataWithCache(tempDir, "https://cached.com", async () => {
        fetcherCalled = true;
        return { url: "https://cached.com", type: "article", title: "Fresh" };
      });

      expect(fetcherCalled).toBe(false);
      expect(result.title).toBe("Cached");
    });

    test("calls fetcher for uncached URL", async () => {
      let fetcherCalled = false;
      const result = await getMetadataWithCache(tempDir, "https://new.com", async (url) => {
        fetcherCalled = true;
        return { url, type: "article", title: "Fetched" };
      });

      expect(fetcherCalled).toBe(true);
      expect(result.title).toBe("Fetched");
    });

    test("caches fetched result", async () => {
      let fetchCount = 0;
      const fetcher = async (url: string): Promise<LinkMetadata> => {
        fetchCount++;
        return { url, type: "article", title: `Fetch ${fetchCount}` };
      };

      // First call - should fetch
      await getMetadataWithCache(tempDir, "https://test.com", fetcher);
      expect(fetchCount).toBe(1);

      // Second call - should use cache
      const result = await getMetadataWithCache(tempDir, "https://test.com", fetcher);
      expect(fetchCount).toBe(1);
      expect(result.title).toBe("Fetch 1");
    });
  });

  describe("cache TTL", () => {
    test("returns cached data within TTL", async () => {
      const metadata: LinkMetadata = { url: "https://fresh.com", type: "article" };
      await cacheMetadata(tempDir, "https://fresh.com", metadata);

      // Should still be fresh
      const result = await getCachedMetadata(tempDir, "https://fresh.com");
      expect(result).toEqual(metadata);
    });

    test("returns null for expired cache entries", async () => {
      // Manually write an expired cache entry
      const expiredEntry = {
        "https://old.com": {
          metadata: { url: "https://old.com", type: "article" as const },
          fetchedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
        },
      };
      await Bun.write(join(tempDir, "metadata-cache.json"), JSON.stringify(expiredEntry));

      const result = await getCachedMetadata(tempDir, "https://old.com");
      expect(result).toBeNull();
    });
  });
});
