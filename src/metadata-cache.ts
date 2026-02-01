// Metadata cache: store fetched link metadata to avoid redundant requests

import { join } from "path";
import type { LinkMetadata } from "./types";

interface CacheEntry {
  metadata: LinkMetadata;
  fetchedAt: string; // ISO timestamp
}

interface MetadataCache {
  [url: string]: CacheEntry;
}

const CACHE_FILE = "metadata-cache.json";
const CACHE_TTL_DAYS = 7;

// In-memory cache for current session
let memoryCache: MetadataCache = {};
let cacheLoaded = false;
let outputDir: string | null = null;

// Load cache from disk
async function loadCache(dir: string): Promise<MetadataCache> {
  if (cacheLoaded && outputDir === dir) {
    return memoryCache;
  }

  const cachePath = join(dir, CACHE_FILE);
  const file = Bun.file(cachePath);

  if (await file.exists()) {
    try {
      memoryCache = await file.json();
    } catch {
      console.warn(`Warning: Could not parse ${CACHE_FILE}, starting fresh`);
      memoryCache = {};
    }
  } else {
    memoryCache = {};
  }

  cacheLoaded = true;
  outputDir = dir;
  return memoryCache;
}

// Save cache to disk
async function saveCache(dir: string): Promise<void> {
  const cachePath = join(dir, CACHE_FILE);
  await Bun.write(cachePath, JSON.stringify(memoryCache, null, 2));
}

// Check if a cache entry is still fresh
function isFresh(entry: CacheEntry): boolean {
  const fetchedAt = new Date(entry.fetchedAt);
  const now = new Date();
  const diffMs = now.getTime() - fetchedAt.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays < CACHE_TTL_DAYS;
}

// Get cached metadata for a URL (returns null if not cached or stale)
export async function getCachedMetadata(
  dir: string,
  url: string
): Promise<LinkMetadata | null> {
  const cache = await loadCache(dir);
  const entry = cache[url];

  if (entry && isFresh(entry)) {
    return entry.metadata;
  }

  return null;
}

// Cache metadata for a URL
export async function cacheMetadata(
  dir: string,
  url: string,
  metadata: LinkMetadata
): Promise<void> {
  await loadCache(dir); // Ensure cache is loaded

  memoryCache[url] = {
    metadata,
    fetchedAt: new Date().toISOString(),
  };

  await saveCache(dir);
}

// Get metadata with caching - fetch if not cached or stale
export async function getMetadataWithCache(
  dir: string,
  url: string,
  fetcher: (url: string) => Promise<LinkMetadata>
): Promise<LinkMetadata> {
  // Check cache first
  const cached = await getCachedMetadata(dir, url);
  if (cached) {
    return cached;
  }

  // Fetch and cache
  const metadata = await fetcher(url);
  await cacheMetadata(dir, url, metadata);
  return metadata;
}
