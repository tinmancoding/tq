/**
 * shape.test.ts — unit tests for HTML→Markdown conversion and truncation.
 */

import { describe, it, expect } from "vitest";
import { htmlToMarkdown, truncate } from "../shape.js";

describe("htmlToMarkdown", () => {
  it("returns empty string for null/undefined/empty input", () => {
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
    expect(htmlToMarkdown("")).toBe("");
  });

  it("converts headings", () => {
    const md = htmlToMarkdown("<h1>Title</h1><h2>Sub</h2><h3>Sub-sub</h3>");
    expect(md).toContain("# Title");
    expect(md).toContain("## Sub");
    expect(md).toContain("### Sub-sub");
  });

  it("converts unordered lists", () => {
    const md = htmlToMarkdown("<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>");
    // turndown uses '- ' followed by spaces; just verify the list marker and text are present
    expect(md).toMatch(/^-\s+Alpha/m);
    expect(md).toMatch(/^-\s+Beta/m);
    expect(md).toMatch(/^-\s+Gamma/m);
  });

  it("converts ordered lists", () => {
    const md = htmlToMarkdown("<ol><li>First</li><li>Second</li></ol>");
    expect(md).toContain("1.");
    expect(md).toContain("First");
    expect(md).toContain("Second");
  });

  it("converts links to referenced style", () => {
    const md = htmlToMarkdown('<a href="https://example.com">Click here</a>');
    // turndown referenced style: [Click here][1] or [Click here](https://example.com)
    expect(md).toContain("Click here");
    expect(md).toContain("https://example.com");
  });

  it("converts tables", () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody><tr><td>Foo</td><td>Bar</td></tr></tbody>
      </table>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("Name");
    expect(md).toContain("Value");
    expect(md).toContain("Foo");
    expect(md).toContain("Bar");
    // Should have a markdown table separator
    expect(md).toContain("|");
    // GFM table must have the --- separator row between header and body
    expect(md).toMatch(/\|\s*---/);
  });

  it("converts bold and italic", () => {
    const md = htmlToMarkdown("<p><strong>bold</strong> and <em>italic</em></p>");
    expect(md).toContain("**bold**");
    expect(md).toContain("_italic_");
  });

  it("converts inline code", () => {
    const md = htmlToMarkdown("<p>Use <code>npm install</code> to install.</p>");
    expect(md).toContain("`npm install`");
  });

  it("converts fenced code blocks", () => {
    const md = htmlToMarkdown("<pre><code>const x = 1;</code></pre>");
    expect(md).toContain("```");
    expect(md).toContain("const x = 1;");
  });

  it("strips script tags", () => {
    const md = htmlToMarkdown('<script>alert("xss")</script><p>Clean</p>');
    expect(md).not.toContain("alert");
    expect(md).not.toContain("<script>");
    expect(md).toContain("Clean");
  });

  it("strips style tags", () => {
    const md = htmlToMarkdown("<style>.foo { color: red; }</style><p>Content</p>");
    expect(md).not.toContain("color: red");
    expect(md).not.toContain("<style>");
    expect(md).toContain("Content");
  });

  it("handles nested lists", () => {
    const html = "<ul><li>Parent<ul><li>Child</li></ul></li></ul>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("Parent");
    expect(md).toContain("Child");
  });
});

describe("truncate", () => {
  it("returns the string unchanged when within budget", () => {
    const s = "Hello, world!";
    expect(truncate(s, 100)).toBe(s);
    expect(truncate(s, s.length)).toBe(s);
  });

  it("truncates to maxChars and appends an ellipsis note", () => {
    const s = "ABCDEFGHIJ"; // 10 chars
    const result = truncate(s, 5);
    expect(result.startsWith("ABCDE")).toBe(true);
    expect(result).toContain("truncated");
    expect(result).toContain("5 chars omitted");
  });

  it("the truncated result length equals maxChars plus the suffix", () => {
    const s = "x".repeat(1000);
    const result = truncate(s, 200);
    // First 200 chars + suffix
    expect(result.slice(0, 200)).toBe("x".repeat(200));
    expect(result.length).toBeGreaterThan(200);
  });

  it("handles empty string", () => {
    expect(truncate("", 100)).toBe("");
  });

  it("handles zero budget — cuts all chars", () => {
    const result = truncate("hello", 0);
    expect(result).toContain("truncated");
    expect(result).toContain("5 chars omitted");
  });
});
