import { join, basename } from "path";
import { mkdir } from "fs/promises";
import type { LocalMedia } from "./types";

// TweetMedia type from bird (not exported from main entry)
interface TweetMedia {
  type: "photo" | "video" | "animated_gif";
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  videoUrl?: string;
  durationMs?: number;
}

const ASSETS_DIR = "assets";

export async function ensureAssetsDir(outputDir: string): Promise<void> {
  const assetsPath = join(outputDir, ASSETS_DIR);
  await mkdir(assetsPath, { recursive: true });
}

export async function downloadMedia(
  media: TweetMedia[],
  outputDir: string
): Promise<LocalMedia[]> {
  const results: LocalMedia[] = [];

  for (const item of media) {
    try {
      let url: string;
      let filename: string;

      if (item.type === "video" || item.type === "animated_gif") {
        // For videos, try to get the highest quality mp4
        if (item.videoUrl) {
          url = item.videoUrl;
          filename = basename(new URL(url).pathname);
        } else {
          // Fallback to preview image
          url = item.url;
          filename = basename(new URL(url).pathname);
        }
      } else {
        // For photos, get the original size
        // Twitter URLs often have size params, get the largest
        url = item.url.replace(/&name=\w+/, "&name=large");
        if (!url.includes("name=")) {
          url = url + (url.includes("?") ? "&" : "?") + "name=large";
        }
        filename = basename(new URL(url).pathname);
      }

      // Ensure unique filename
      if (!filename || filename === "/") {
        filename = `media_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      }

      const localPath = join(ASSETS_DIR, filename);
      const fullPath = join(outputDir, localPath);

      // Check if already downloaded
      if (await Bun.file(fullPath).exists()) {
        results.push({
          type: item.type,
          localPath,
          originalUrl: item.url,
        });
        continue;
      }

      // Download
      const response = await fetch(url, {
        signal: AbortSignal.timeout(60000), // 60s timeout for videos
      });

      if (!response.ok) {
        console.warn(`Failed to download media: ${url} (${response.status})`);
        continue;
      }

      const buffer = await response.arrayBuffer();
      await Bun.write(fullPath, buffer);

      results.push({
        type: item.type,
        localPath,
        originalUrl: item.url,
      });
    } catch (error) {
      console.warn(`Error downloading media: ${error}`);
      // Continue with other media
    }
  }

  return results;
}
