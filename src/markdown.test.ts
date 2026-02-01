import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import {
  extractHashtags,
  generateFrontmatter,
  parseFrontmatter,
  mergeFrontmatter,
  writeBookmarkMarkdown,
} from "./markdown";
import type { ProcessedBookmark, ProcessedTweet, LinkMetadata } from "./types";

describe("extractHashtags", () => {
  test("extracts hashtags from text", () => {
    expect(extractHashtags("Check out #ClaudeCode")).toEqual(["ClaudeCode"]);
    expect(extractHashtags("#AI is amazing")).toEqual(["AI"]);
  });

  test("extracts multiple hashtags", () => {
    const result = extractHashtags("Building with #TypeScript and #Bun");
    expect(result).toEqual(["TypeScript", "Bun"]);
  });

  test("removes # prefix", () => {
    const result = extractHashtags("#test");
    expect(result).toEqual(["test"]);
    expect(result[0]).not.toContain("#");
  });

  test("deduplicates hashtags", () => {
    const result = extractHashtags("#AI is #AI powered by #AI");
    expect(result).toEqual(["AI"]);
  });

  test("returns empty array when no hashtags", () => {
    expect(extractHashtags("No hashtags here")).toEqual([]);
    expect(extractHashtags("")).toEqual([]);
  });

  test("handles hashtags with underscores and numbers", () => {
    const result = extractHashtags("#100DaysOfCode #my_tag #v2");
    expect(result).toContain("100DaysOfCode");
    expect(result).toContain("my_tag");
    expect(result).toContain("v2");
  });

  test("handles hashtags on multiple lines", () => {
    const result = extractHashtags("#first\n#second\n#third");
    expect(result).toEqual(["first", "second", "third"]);
  });
});

// Helper to create mock ProcessedTweet
function createMockTweet(overrides: Partial<ProcessedTweet> = {}): ProcessedTweet {
  return {
    id: "123456789",
    text: "Original tweet text #hashtag",
    processedText: "Processed tweet text `#hashtag`",
    author: { username: "testuser", name: "Test User" },
    createdAt: "2026-01-29T12:00:00.000Z",
    localMedia: [],
    linkedStatusIds: [],
    linkedArticleIds: [],
    resolvedUrls: [],
    ...overrides,
  } as ProcessedTweet;
}

// Helper to create mock ProcessedBookmark
function createMockBookmark(overrides: Partial<ProcessedBookmark> = {}): ProcessedBookmark {
  return {
    originalTweet: createMockTweet(),
    threadTweets: [],
    replies: [],
    ...overrides,
  };
}

describe("generateFrontmatter", () => {
  test("generates basic frontmatter", () => {
    const bookmark = createMockBookmark();
    const result = generateFrontmatter(bookmark, []);

    expect(result).toContain("---");
    expect(result).toContain('id: "123456789"');
    expect(result).toContain("author: testuser");
    expect(result).toContain('author_name: "Test User"');
    expect(result).toContain("date: 2026-01-29");
    expect(result).toContain("url: https://twitter.com/testuser/status/123456789");
  });

  test("includes thread_length when > 1", () => {
    const bookmark = createMockBookmark({
      threadTweets: [createMockTweet(), createMockTweet()],
    });
    const result = generateFrontmatter(bookmark, []);

    expect(result).toContain("thread_length: 3"); // 1 original + 2 thread
  });

  test("omits thread_length when 1", () => {
    const bookmark = createMockBookmark();
    const result = generateFrontmatter(bookmark, []);

    expect(result).not.toContain("thread_length:");
  });

  test("includes reply_count when > 0", () => {
    const bookmark = createMockBookmark({
      replies: [createMockTweet(), createMockTweet(), createMockTweet()],
    });
    const result = generateFrontmatter(bookmark, []);

    expect(result).toContain("reply_count: 3");
  });

  test("includes media_count when > 0", () => {
    const bookmark = createMockBookmark({
      originalTweet: createMockTweet({
        localMedia: [
          { type: "photo", localPath: "assets/1.jpg", originalUrl: "..." },
          { type: "photo", localPath: "assets/2.jpg", originalUrl: "..." },
        ],
      }),
    });
    const result = generateFrontmatter(bookmark, []);

    expect(result).toContain("media_count: 2");
  });

  test("counts media across thread tweets", () => {
    const bookmark = createMockBookmark({
      originalTweet: createMockTweet({
        localMedia: [{ type: "photo", localPath: "assets/1.jpg", originalUrl: "..." }],
      }),
      threadTweets: [
        createMockTweet({
          localMedia: [{ type: "video", localPath: "assets/2.mp4", originalUrl: "..." }],
        }),
      ],
    });
    const result = generateFrontmatter(bookmark, []);

    expect(result).toContain("media_count: 2");
  });

  test("includes quoted_tweet when present", () => {
    const bookmark = createMockBookmark({
      originalTweet: createMockTweet({
        processedQuotedTweet: createMockTweet({ id: "quoted123" }),
      }),
    });
    const result = generateFrontmatter(bookmark, []);

    expect(result).toContain('quoted_tweet: "quoted123"');
  });

  test("extracts hashtags from original tweet text (not processedText)", () => {
    const bookmark = createMockBookmark({
      originalTweet: createMockTweet({
        text: "Check out #ClaudeCode and #AI",
        processedText: "Check out `#ClaudeCode` and `#AI`",
      }),
    });
    const result = generateFrontmatter(bookmark, []);

    expect(result).toContain("hashtags:");
    expect(result).toContain("  - ClaudeCode");
    expect(result).toContain("  - AI");
  });

  test("includes link metadata", () => {
    const bookmark = createMockBookmark();
    const linkMetadata: LinkMetadata[] = [
      {
        url: "https://github.com/anthropics/claude-code",
        type: "github",
        owner: "anthropics",
        repo: "claude-code",
        description: "CLI for Claude",
        stars: 12345,
        language: "TypeScript",
        topics: ["cli", "ai"],
      },
    ];
    const result = generateFrontmatter(bookmark, linkMetadata);

    expect(result).toContain("links:");
    expect(result).toContain("  - url: https://github.com/anthropics/claude-code");
    expect(result).toContain("    type: github");
    expect(result).toContain("    owner: anthropics");
    expect(result).toContain("    repo: claude-code");
    expect(result).toContain('    description: "CLI for Claude"');
    expect(result).toContain("    stars: 12345");
    expect(result).toContain("    language: TypeScript");
    expect(result).toContain('    topics: ["cli", "ai"]');
  });

  test("includes article link metadata", () => {
    const bookmark = createMockBookmark();
    const linkMetadata: LinkMetadata[] = [
      {
        url: "https://example.com/article",
        type: "article",
        title: "Article Title",
        description: "Meta description",
        site: "example.com",
      },
    ];
    const result = generateFrontmatter(bookmark, linkMetadata);

    expect(result).toContain("links:");
    expect(result).toContain("  - url: https://example.com/article");
    expect(result).toContain("    type: article");
    expect(result).toContain('    title: "Article Title"');
    expect(result).toContain('    description: "Meta description"');
    expect(result).toContain("    site: example.com");
  });

  test("handles multiple links", () => {
    const bookmark = createMockBookmark();
    const linkMetadata: LinkMetadata[] = [
      { url: "https://github.com/a/b", type: "github", owner: "a", repo: "b" },
      { url: "https://example.com", type: "article", title: "Example" },
    ];
    const result = generateFrontmatter(bookmark, linkMetadata);

    expect(result).toContain("  - url: https://github.com/a/b");
    expect(result).toContain("  - url: https://example.com");
  });

  test("escapes special characters in YAML strings", () => {
    const bookmark = createMockBookmark({
      originalTweet: createMockTweet({
        author: { username: "user", name: 'Name with "quotes" and \\ backslash' },
      }),
    });
    const result = generateFrontmatter(bookmark, []);

    expect(result).toContain('author_name: "Name with \\"quotes\\" and \\\\ backslash"');
  });

  test("escapes newlines in YAML strings", () => {
    const linkMetadata: LinkMetadata[] = [
      {
        url: "https://example.com",
        type: "article",
        description: "Line one\nLine two",
      },
    ];
    const result = generateFrontmatter(createMockBookmark(), linkMetadata);

    expect(result).toContain('description: "Line one\\nLine two"');
  });

  test("produces valid YAML structure", () => {
    const bookmark = createMockBookmark({
      originalTweet: createMockTweet({
        text: "#tag1 #tag2",
        processedQuotedTweet: createMockTweet({ id: "qt123" }),
        localMedia: [{ type: "photo", localPath: "x", originalUrl: "y" }],
      }),
      threadTweets: [createMockTweet()],
      replies: [createMockTweet()],
    });
    const linkMetadata: LinkMetadata[] = [
      { url: "https://github.com/a/b", type: "github", owner: "a", repo: "b", stars: 100 },
    ];

    const result = generateFrontmatter(bookmark, linkMetadata);

    // Should start and end with ---
    expect(result.startsWith("---\n")).toBe(true);
    expect(result).toContain("\n---\n");

    // Should have proper indentation
    const lines = result.split("\n");
    const hashtagLines = lines.filter((l) => l.startsWith("  - ") && !l.includes("url:"));
    expect(hashtagLines.length).toBeGreaterThan(0);
  });
});

describe("parseFrontmatter", () => {
  test("returns null frontmatter for content without frontmatter", () => {
    const content = "# Thread\n\nSome content here";
    const result = parseFrontmatter(content);

    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(content);
  });

  test("parses simple key-value frontmatter", () => {
    const content = `---
id: "123456"
author: testuser
date: 2026-01-29
---
# Thread

Content here`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.id).toBe("123456");
    expect(result.frontmatter!.author).toBe("testuser");
    expect(result.frontmatter!.date).toBe("2026-01-29");
    expect(result.body).toBe("# Thread\n\nContent here");
  });

  test("parses array values", () => {
    const content = `---
hashtags:
  - ClaudeCode
  - AI
  - TypeScript
---
Body`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter!.hashtags).toEqual(["ClaudeCode", "AI", "TypeScript"]);
  });

  test("parses numeric values", () => {
    const content = `---
stars: 12345
reply_count: 5
---
Body`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter!.stars).toBe(12345);
    expect(result.frontmatter!.reply_count).toBe(5);
  });

  test("parses boolean values", () => {
    const content = `---
featured: true
archived: false
---
Body`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter!.featured).toBe(true);
    expect(result.frontmatter!.archived).toBe(false);
  });

  test("handles quoted strings", () => {
    const content = `---
author_name: "User With Spaces"
id: "123"
---
Body`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter!.author_name).toBe("User With Spaces");
    expect(result.frontmatter!.id).toBe("123");
  });

  test("handles empty frontmatter", () => {
    const content = `---
---
Body`;

    const result = parseFrontmatter(content);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Body");
  });

  test("preserves body content exactly", () => {
    const body = "# Thread\n\n**@user** (Name)\n\nTweet content\n\n![](image.jpg)";
    const content = `---
id: "123"
---
${body}`;

    const result = parseFrontmatter(content);

    expect(result.body).toBe(body);
  });
});

describe("mergeFrontmatter", () => {
  test("preserves existing values over generated ones", () => {
    const existing = {
      id: "123",
      author: "existing_user",
      custom_field: "preserved",
    };

    const generated = `---
id: "123"
author: new_user
date: 2026-01-29
---
`;

    const result = mergeFrontmatter(existing, generated);

    expect(result).toContain("author: existing_user");
    expect(result).toContain("date: 2026-01-29"); // New field added
    expect(result).toContain("custom_field: preserved"); // Custom field preserved
    expect(result).not.toContain("new_user");
  });

  test("adds new fields from generated frontmatter", () => {
    const existing = {
      id: "123",
    };

    const generated = `---
id: "123"
author: testuser
hashtags:
  - AI
---
`;

    const result = mergeFrontmatter(existing, generated);

    expect(result).toContain('id: "123"');
    expect(result).toContain("author: testuser");
    expect(result).toContain("hashtags:");
    expect(result).toContain("  - AI");
  });

  test("preserves existing arrays", () => {
    const existing = {
      hashtags: ["CustomTag1", "CustomTag2"],
    };

    const generated = `---
hashtags:
  - AI
  - Generated
---
`;

    const result = mergeFrontmatter(existing, generated);

    expect(result).toContain("  - CustomTag1");
    expect(result).toContain("  - CustomTag2");
    expect(result).not.toContain("  - AI");
    expect(result).not.toContain("  - Generated");
  });

  test("produces valid YAML structure", () => {
    const existing = { custom: "value" };
    const generated = `---
id: "123"
author: test
---
`;

    const result = mergeFrontmatter(existing, generated);

    expect(result.startsWith("---\n")).toBe(true);
    // Ends with closing --- followed by blank line
    expect(result).toContain("\n---\n");
  });
});

describe("writeBookmarkMarkdown with options", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "birdmarks-write-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("mergeExistingFrontmatter preserves custom fields", async () => {
    // Create an existing file with custom frontmatter
    const existingContent = `---
id: "123456789"
author: testuser
custom_note: "My personal note"
rating: 5
---
# Thread

**@testuser** (Test User)

Original content`;

    const filepath = join(tempDir, "2026-01-29-testuser-123456789.md");
    await Bun.write(filepath, existingContent);

    // Create a mock bookmark
    const bookmark = createMockBookmark({
      originalTweet: createMockTweet({
        id: "123456789",
        createdAt: "2026-01-29T12:00:00.000Z",
      }),
    });

    // Write with merge option
    await writeBookmarkMarkdown(bookmark, tempDir, {
      mergeExistingFrontmatter: true,
      frontmatterOnly: true,
    });

    // Read the result
    const result = await Bun.file(filepath).text();

    // Custom fields should be preserved (note: simple strings don't get quoted)
    expect(result).toContain("custom_note:");
    expect(result).toContain("My personal note");
    expect(result).toContain("rating: 5");
    // Standard fields should still be there
    expect(result).toContain('id: "123456789"');
    expect(result).toContain("author: testuser");
    // Body should be preserved
    expect(result).toContain("Original content");
  });

  test("frontmatterOnly keeps existing body unchanged", async () => {
    const customBody = `# Thread

**@testuser** (Test User)

This is my custom edited content that I don't want overwritten.

## My Custom Section

More custom stuff.`;

    const existingContent = `---
id: "123456789"
---
${customBody}`;

    const filepath = join(tempDir, "2026-01-29-testuser-123456789.md");
    await Bun.write(filepath, existingContent);

    const bookmark = createMockBookmark({
      originalTweet: createMockTweet({
        id: "123456789",
        createdAt: "2026-01-29T12:00:00.000Z",
        text: "New tweet text that would generate different body",
        processedText: "New tweet text that would generate different body",
      }),
    });

    await writeBookmarkMarkdown(bookmark, tempDir, {
      frontmatterOnly: true,
    });

    const result = await Bun.file(filepath).text();

    // Body should be exactly as before
    expect(result).toContain("This is my custom edited content");
    expect(result).toContain("## My Custom Section");
    // Should NOT contain the new tweet text in body
    expect(result.indexOf("New tweet text")).toBeLessThan(result.indexOf("---\n", 4) + 4);
  });
});
