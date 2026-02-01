import { describe, test, expect } from "bun:test";
import {
  detectLinkType,
  parseOGTags,
  extractGitHubMetadata,
  extractOGMetadata,
} from "./metadata";

describe("detectLinkType", () => {
  test("identifies GitHub repository URLs", () => {
    expect(detectLinkType("https://github.com/anthropics/claude-code")).toBe("github");
    expect(detectLinkType("https://github.com/facebook/react")).toBe("github");
    expect(detectLinkType("https://www.github.com/vercel/next.js")).toBe("github");
    // With path segments
    expect(detectLinkType("https://github.com/anthropics/claude-code/tree/main")).toBe("github");
    expect(detectLinkType("https://github.com/anthropics/claude-code/blob/main/README.md")).toBe("github");
  });

  test("identifies GitHub non-repo URLs as articles", () => {
    expect(detectLinkType("https://github.com/features")).toBe("article");
    expect(detectLinkType("https://github.com/pricing")).toBe("article");
    expect(detectLinkType("https://github.com")).toBe("article");
  });

  test("identifies YouTube URLs", () => {
    expect(detectLinkType("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
    expect(detectLinkType("https://www.youtube.com/watch?v=abc123")).toBe("youtube");
    expect(detectLinkType("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(detectLinkType("https://m.youtube.com/watch?v=abc")).toBe("youtube");
  });

  test("identifies article URLs (everything else)", () => {
    expect(detectLinkType("https://example.com/blog/post")).toBe("article");
    expect(detectLinkType("https://nytimes.com/2024/01/article")).toBe("article");
    expect(detectLinkType("https://medium.com/@user/post-title")).toBe("article");
    expect(detectLinkType("https://substack.com/p/newsletter")).toBe("article");
  });

  test("returns unknown for invalid URLs", () => {
    expect(detectLinkType("not-a-url")).toBe("unknown");
    expect(detectLinkType("")).toBe("unknown");
    expect(detectLinkType("ftp://files.example.com")).toBe("article"); // valid URL, just not special
  });
});

describe("parseOGTags", () => {
  test("extracts all OG tags from HTML", () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta property="og:title" content="Test Article Title">
        <meta property="og:description" content="This is a test description">
        <meta property="og:site_name" content="Example Site">
      </head>
      <body></body>
      </html>
    `;

    const result = parseOGTags("https://example.com/article", html);

    expect(result.url).toBe("https://example.com/article");
    expect(result.type).toBe("article");
    expect(result.title).toBe("Test Article Title");
    expect(result.description).toBe("This is a test description");
    expect(result.site).toBe("Example Site");
  });

  test("handles reversed attribute order", () => {
    const html = `
      <meta content="Reversed Order Title" property="og:title">
      <meta content="Reversed description" property="og:description">
    `;

    const result = parseOGTags("https://example.com", html);

    expect(result.title).toBe("Reversed Order Title");
    expect(result.description).toBe("Reversed description");
  });

  test("decodes HTML entities in OG content", () => {
    const html = `
      <meta property="og:title" content="Title with &amp; ampersand">
      <meta property="og:description" content="Quotes: &quot;hello&quot; and &#39;world&#39;">
    `;

    const result = parseOGTags("https://example.com", html);

    expect(result.title).toBe("Title with & ampersand");
    expect(result.description).toBe('Quotes: "hello" and \'world\'');
  });

  test("falls back to hostname when og:site_name missing", () => {
    const html = `<meta property="og:title" content="Just a title">`;

    const result = parseOGTags("https://news.ycombinator.com/item", html);

    expect(result.site).toBe("news.ycombinator.com");
  });

  test("handles missing OG tags gracefully", () => {
    const html = `<html><head><title>Plain HTML</title></head></html>`;

    const result = parseOGTags("https://example.com", html);

    expect(result.url).toBe("https://example.com");
    expect(result.type).toBe("article");
    expect(result.title).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  test("handles YouTube type", () => {
    const html = `
      <meta property="og:title" content="Video Title">
      <meta property="og:site_name" content="YouTube">
    `;

    const result = parseOGTags("https://youtube.com/watch?v=abc", html, "youtube");

    expect(result.type).toBe("youtube");
    expect(result.title).toBe("Video Title");
  });
});

describe("parseOGTags edge cases", () => {
  test("handles single quotes in meta tags", () => {
    const html = `<meta property='og:title' content='Single Quoted'>`;
    const result = parseOGTags("https://example.com", html);
    expect(result.title).toBe("Single Quoted");
  });

  test("handles extra whitespace", () => {
    const html = `<meta   property="og:title"   content="  Whitespace Title  ">`;
    const result = parseOGTags("https://example.com", html);
    expect(result.title).toBe("Whitespace Title");
  });

  test("handles multiline meta tags", () => {
    const html = `
      <meta
        property="og:title"
        content="Multiline Tag">
    `;
    const result = parseOGTags("https://example.com", html);
    expect(result.title).toBe("Multiline Tag");
  });
});
