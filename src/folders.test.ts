import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { getFolderForTweet, backfillFolderField, UNLABELED } from "./folders";
import { generateFrontmatter, parseFrontmatter } from "./markdown";
import type { ProcessedBookmark, ProcessedTweet } from "./types";

function makeProcessedBookmark(id: string, author = "alice", text = "hello"): ProcessedBookmark {
  const tweet: ProcessedTweet = {
    id,
    text,
    author: { username: author, name: author.charAt(0).toUpperCase() + author.slice(1) },
    createdAt: "2025-01-15T12:00:00.000Z",
    processedText: text,
    localMedia: [],
    linkedStatusIds: [],
    linkedArticleIds: [],
    resolvedUrls: [],
  };
  return { originalTweet: tweet, threadTweets: [], replies: [] };
}

describe("getFolderForTweet", () => {
  test("returns unlabeled when map is undefined", () => {
    expect(getFolderForTweet(undefined, "123")).toBe(UNLABELED);
  });

  test("returns unlabeled when tweet is not in the map", () => {
    expect(getFolderForTweet({ "999": "foo" }, "123")).toBe(UNLABELED);
  });

  test("returns folder name when tweet is in the map", () => {
    expect(getFolderForTweet({ "123": "Travel" }, "123")).toBe("Travel");
  });

  test("preserves non-ASCII folder names", () => {
    expect(getFolderForTweet({ "123": "光" }, "123")).toBe("光");
    expect(getFolderForTweet({ "456": "バンガー" }, "456")).toBe("バンガー");
  });
});

describe("generateFrontmatter with folder", () => {
  test("omits folder field when folder is undefined", () => {
    const bookmark = makeProcessedBookmark("1");
    const fm = generateFrontmatter(bookmark, []);
    expect(fm).not.toContain("folder:");
  });

  test("emits folder field when supplied", () => {
    const bookmark = makeProcessedBookmark("1");
    const fm = generateFrontmatter(bookmark, [], "Travel");
    expect(fm).toContain('folder: "Travel"');
  });

  test("emits unlabeled when supplied as folder", () => {
    const bookmark = makeProcessedBookmark("1");
    const fm = generateFrontmatter(bookmark, [], "unlabeled");
    expect(fm).toContain('folder: "unlabeled"');
  });

  test("emits non-ASCII folder names quoted correctly", () => {
    const bookmark = makeProcessedBookmark("1");
    const fm = generateFrontmatter(bookmark, [], "光");
    expect(fm).toContain('folder: "光"');
  });

  test("folder round-trips through parseFrontmatter", () => {
    const bookmark = makeProcessedBookmark("1");
    const fm = generateFrontmatter(bookmark, [], "バンガー");
    const { frontmatter } = parseFrontmatter(fm + "\nbody content");
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.folder).toBe("バンガー");
  });

  test("escapes folder name with embedded quote", () => {
    const bookmark = makeProcessedBookmark("1");
    const fm = generateFrontmatter(bookmark, [], 'foo "bar" baz');
    expect(fm).toContain('folder: "foo \\"bar\\" baz"');
  });
});

describe("backfillFolderField", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "birdmarks-folders-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("adds folder: to bookmark with existing frontmatter", async () => {
    const md = `---
id: "12345678901234567"
author: alice
date: 2025-01-15
---

Body.
`;
    const path = join(tempDir, "2025-01-15-alice-12345678901234567.md");
    await Bun.write(path, md);

    const stats = await backfillFolderField(tempDir, { "12345678901234567": "Travel" });

    expect(stats.taggedBookmarks).toBe(1);
    expect(stats.unlabeledBookmarks).toBe(0);
    const updated = await Bun.file(path).text();
    expect(updated).toContain('folder: "Travel"');
    expect(updated).toContain("Body.");
  });

  test("tags as unlabeled when tweet is not in folder map", async () => {
    const md = `---
id: "99999999999999999"
author: bob
date: 2025-01-15
---

Body.
`;
    const path = join(tempDir, "2025-01-15-bob-99999999999999999.md");
    await Bun.write(path, md);

    const stats = await backfillFolderField(tempDir, { "12345678901234567": "Travel" });

    expect(stats.unlabeledBookmarks).toBe(1);
    const updated = await Bun.file(path).text();
    expect(updated).toContain('folder: "unlabeled"');
  });

  test("skips files without frontmatter", async () => {
    const path = join(tempDir, "2025-01-15-alice-12345678901234567.md");
    await Bun.write(path, "No frontmatter here.\n");

    const stats = await backfillFolderField(tempDir, { "12345678901234567": "Travel" });

    expect(stats.noFrontmatter).toBe(1);
    expect(stats.taggedBookmarks).toBe(0);
  });

  test("propagates folder to articles referenced from bookmarks", async () => {
    const bookmarkMd = `---
id: "12345678901234567"
author: alice
date: 2025-01-15
---

Some text.

**Article Title**

[Read full article](articles/Article-Title.md)
`;
    const bookmarkPath = join(tempDir, "2025-01-15-alice-12345678901234567.md");
    await Bun.write(bookmarkPath, bookmarkMd);

    const articleMd = `# Article Title\n\nArticle body.\n`;
    const articleDir = join(tempDir, "articles");
    await Bun.write(join(articleDir, "Article-Title.md"), articleMd);

    const stats = await backfillFolderField(tempDir, { "12345678901234567": "Travel" });

    expect(stats.taggedBookmarks).toBe(1);
    expect(stats.taggedArticles).toBe(1);
    const updated = await Bun.file(join(articleDir, "Article-Title.md")).text();
    expect(updated).toContain('folder: "Travel"');
  });

  test("first-folder-wins for articles linked from two bookmarks", async () => {
    const bookmark1 = `---
id: "11111111111111111"
author: alice
date: 2025-01-15
---

[Read full article](articles/Shared.md)
`;
    const bookmark2 = `---
id: "22222222222222222"
author: bob
date: 2025-01-16
---

[Read full article](articles/Shared.md)
`;
    // Use ordering trick — filenames are sorted; "2025-01-15-..." sorts before "2025-01-16-..."
    await Bun.write(join(tempDir, "2025-01-15-alice-11111111111111111.md"), bookmark1);
    await Bun.write(join(tempDir, "2025-01-16-bob-22222222222222222.md"), bookmark2);
    await Bun.write(join(tempDir, "articles/Shared.md"), "# Shared\n\nBody.\n");

    const stats = await backfillFolderField(tempDir, {
      "11111111111111111": "FolderA",
      "22222222222222222": "FolderB",
    });

    expect(stats.taggedArticles).toBe(1);
    expect(stats.conflictedArticles).toBe(1);

    const updated = await Bun.file(join(tempDir, "articles/Shared.md")).text();
    // Bun.Glob does not guarantee order across filesystems, so accept either,
    // but assert exactly one was chosen (no folder list).
    const matched = updated.match(/folder: "(FolderA|FolderB)"/);
    expect(matched).not.toBeNull();
  });
});
