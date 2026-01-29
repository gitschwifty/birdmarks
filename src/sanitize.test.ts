import { describe, test, expect } from "bun:test";
import { sanitizeFilename } from "./state";

describe("sanitizeFilename", () => {
  // Examples from the problem description
  test("removes curly apostrophes from article titles", () => {
    expect(sanitizeFilename("How-we-built-Agent-Builder's-memory-system")).toBe(
      "How-we-built-Agent-Builders-memory-system"
    );
    expect(sanitizeFilename("We're-turning-Todos-into-Tasks-in-Claude-Code")).toBe(
      "Were-turning-Todos-into-Tasks-in-Claude-Code"
    );
  });

  // Curly quotes/apostrophes
  test("removes left single curly quote", () => {
    expect(sanitizeFilename(`test\u2018string`)).toBe("teststring"); // '
  });

  test("removes right single curly quote", () => {
    expect(sanitizeFilename(`test\u2019string`)).toBe("teststring"); // '
  });

  test("removes left double curly quote", () => {
    expect(sanitizeFilename(`test\u201Cstring`)).toBe("teststring"); // "
  });

  test("removes right double curly quote", () => {
    expect(sanitizeFilename(`test\u201Dstring`)).toBe("teststring"); // "
  });

  // Unicode punctuation
  test("replaces en-dash with hyphen", () => {
    expect(sanitizeFilename("2020–2024")).toBe("2020-2024");
  });

  test("replaces em-dash with hyphen", () => {
    expect(sanitizeFilename("hello—world")).toBe("hello-world");
  });

  test("removes Unicode ellipsis", () => {
    expect(sanitizeFilename("wait…what")).toBe("waitwhat");
  });

  test("removes multiple dots", () => {
    expect(sanitizeFilename("hello...world")).toBe("helloworld");
    expect(sanitizeFilename("test..file")).toBe("testfile");
  });

  // Non-ASCII characters
  test("removes non-ASCII characters", () => {
    expect(sanitizeFilename("café")).toBe("caf");
    expect(sanitizeFilename("naïve")).toBe("nave");
    expect(sanitizeFilename("日本語")).toBe("");
    expect(sanitizeFilename("emoji🎉test")).toBe("emojitest");
  });

  // Filesystem-invalid characters
  test("removes less than", () => {
    expect(sanitizeFilename("a<b")).toBe("ab");
  });

  test("removes greater than", () => {
    expect(sanitizeFilename("a>b")).toBe("ab");
  });

  test("removes colon", () => {
    expect(sanitizeFilename("a:b")).toBe("ab");
  });

  test("removes double quote", () => {
    expect(sanitizeFilename('a"b')).toBe("ab");
  });

  test("removes forward slash", () => {
    expect(sanitizeFilename("a/b")).toBe("ab");
  });

  test("removes backslash", () => {
    expect(sanitizeFilename("a\\b")).toBe("ab");
  });

  test("removes pipe", () => {
    expect(sanitizeFilename("a|b")).toBe("ab");
  });

  test("removes question mark", () => {
    expect(sanitizeFilename("a?b")).toBe("ab");
  });

  test("removes asterisk", () => {
    expect(sanitizeFilename("a*b")).toBe("ab");
  });

  // Obsidian link-breaking characters
  test("removes hash (Obsidian tags/headings)", () => {
    expect(sanitizeFilename("section#heading")).toBe("sectionheading");
  });

  test("removes square brackets (Obsidian links)", () => {
    expect(sanitizeFilename("[[wikilink]]")).toBe("wikilink");
    expect(sanitizeFilename("a[b]c")).toBe("abc");
  });

  test("removes caret (Obsidian block refs)", () => {
    expect(sanitizeFilename("block^ref")).toBe("blockref");
  });

  test("removes parentheses", () => {
    expect(sanitizeFilename("function(arg)")).toBe("functionarg");
    expect(sanitizeFilename("(test)")).toBe("test");
  });

  test("removes exclamation mark (Obsidian embeds)", () => {
    expect(sanitizeFilename("Hello!World")).toBe("HelloWorld");
  });

  test("removes commas", () => {
    expect(sanitizeFilename("hello,world")).toBe("helloworld");
    expect(sanitizeFilename("one, two, three")).toBe("one-two-three");
  });

  // Unicode arrows/symbols (caught by non-ASCII removal)
  test("removes Unicode arrows", () => {
    expect(sanitizeFilename("From-Context-Graphs-→-Continual-Learning")).toBe(
      "From-Context-Graphs-Continual-Learning"
    );
  });

  test("removes Unicode stars/symbols", () => {
    expect(sanitizeFilename("⚝-fine-tuning-⚝")).toBe("fine-tuning");
  });

  // Spaces and dashes
  test("replaces spaces with dashes", () => {
    expect(sanitizeFilename("hello world")).toBe("hello-world");
  });

  test("replaces multiple spaces with single dash", () => {
    expect(sanitizeFilename("hello    world")).toBe("hello-world");
  });

  test("collapses multiple dashes to single dash", () => {
    expect(sanitizeFilename("hello---world")).toBe("hello-world");
  });

  // Leading/trailing cleanup
  test("removes leading dashes", () => {
    expect(sanitizeFilename("---hello")).toBe("hello");
  });

  test("removes trailing dashes", () => {
    expect(sanitizeFilename("hello---")).toBe("hello");
  });

  test("removes leading dots", () => {
    expect(sanitizeFilename(".hidden")).toBe("hidden");
  });

  test("removes trailing dots", () => {
    expect(sanitizeFilename("file.")).toBe("file");
  });

  // Combined cases
  test("handles complex real-world title", () => {
    expect(
      sanitizeFilename("What's New in JavaScript: 2024–2025 Edition…")
    ).toBe("Whats-New-in-JavaScript-2024-2025-Edition");
  });

  test("handles username with special chars", () => {
    expect(sanitizeFilename("user_name123")).toBe("user_name123");
    expect(sanitizeFilename("über_user")).toBe("ber_user");
  });

  // Edge cases
  test("handles empty string", () => {
    expect(sanitizeFilename("")).toBe("");
  });

  test("handles string that becomes empty after sanitization", () => {
    expect(sanitizeFilename("…")).toBe("");
    expect(sanitizeFilename("''")).toBe("");
  });

  test("preserves single valid period", () => {
    expect(sanitizeFilename("hello.world")).toBe("hello.world");
  });
});
