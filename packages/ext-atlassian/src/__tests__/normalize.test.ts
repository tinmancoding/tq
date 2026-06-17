/**
 * normalize.test.ts — unit tests for normalize.ts (design §2.2).
 *
 * Covers:
 *   - normalizeIssue: lean output, each include flag, history slice(-10),
 *     renderedFields-preferred body with ADF/empty fallback,
 *     comment author/when index-pairing.
 *   - normalizePage: lean + include flags.
 *   - normalizeJiraSearchResults / normalizeConfluenceSearchResults: hit shapes.
 *
 * All tests use plain fixture objects — no network calls.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeIssue,
  normalizePage,
  normalizeJiraSearchResults,
  normalizeConfluenceSearchResults,
} from "../normalize.js";
import type {
  RawJiraIssue,
  RawConfluencePage,
  RawJiraSearchResult,
  RawConfluenceSearchResult,
} from "../client.js";

const BASE_URL = "https://test.atlassian.net";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRawIssue(overrides: Partial<RawJiraIssue> = {}): RawJiraIssue {
  return {
    id: "10001",
    key: "PROJ-42",
    fields: {
      summary: "Fix the login bug",
      status: { name: "In Progress" },
      issuetype: { name: "Bug" },
      labels: ["backend", "auth"],
      description: { type: "doc", content: [] }, // ADF object — should NOT be used when renderedFields present
      comment: {
        comments: [
          {
            author: { displayName: "Alice Smith" },
            created: "2024-01-01T10:00:00.000Z",
            body: "First comment body (ADF)",
          },
          {
            author: { displayName: "Bob Jones" },
            created: "2024-01-02T12:00:00.000Z",
            body: "Second comment body (ADF)",
          },
        ],
      },
      attachment: [
        { id: "att-1", filename: "screenshot.png", mimeType: "image/png", size: 12345, content: "https://…/screenshot.png" },
        { id: "att-2", filename: "notes.txt", mimeType: "text/plain", size: 500, content: "https://…/notes.txt" },
      ],
    },
    renderedFields: {
      description: "<p>Rendered description HTML</p>",
      comment: {
        comments: [
          { renderedBody: "<p>Rendered first comment</p>" },
          { renderedBody: "<p>Rendered second comment</p>" },
        ],
      },
    },
    changelog: {
      histories: Array.from({ length: 15 }, (_, i) => ({
        author: { displayName: `User ${i}` },
        created: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
      })),
    },
    ...overrides,
  };
}

function makeRawPage(overrides: Partial<RawConfluencePage> = {}): RawConfluencePage {
  return {
    id: "123456789",
    title: "Architecture Overview",
    _links: { webui: "/spaces/DEV/pages/123456789/Architecture+Overview" },
    body: {
      view: { value: "<h1>Architecture</h1><p>Content here.</p>" },
    },
    version: { number: 5, createdAt: "2024-03-01T09:00:00.000Z", authorId: "user-abc" },
    metadata: { labels: { results: [{ name: "architecture" }, { name: "platform" }] } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeIssue — lean output
// ---------------------------------------------------------------------------

describe("normalizeIssue – lean output (no include flags)", () => {
  it("produces correct ref, url, title, status, type, labels", () => {
    const result = normalizeIssue(makeRawIssue(), BASE_URL);
    expect(result.ref).toBe("PROJ-42");
    expect(result.url).toBe("https://test.atlassian.net/browse/PROJ-42");
    expect(result.title).toBe("Fix the login bug");
    expect(result.status).toBe("In Progress");
    expect(result.type).toBe("Bug");
    expect(result.labels).toEqual(["backend", "auth"]);
  });

  it("uses renderedFields.description (HTML→Markdown) for bodyMarkdown", () => {
    const result = normalizeIssue(makeRawIssue(), BASE_URL);
    // <p>Rendered description HTML</p> should produce markdown containing the text
    expect(result.bodyMarkdown).toContain("Rendered description HTML");
  });

  it("does NOT include comments, attachments, or history by default", () => {
    const result = normalizeIssue(makeRawIssue(), BASE_URL);
    expect(result.comments).toBeUndefined();
    expect(result.attachments).toBeUndefined();
    expect(result.history).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeIssue — renderedFields body preference vs ADF fallback
// ---------------------------------------------------------------------------

describe("normalizeIssue – bodyMarkdown source selection", () => {
  it("prefers renderedFields.description when present (HTML→Markdown)", () => {
    const raw = makeRawIssue();
    // renderedFields.description is "<p>Rendered description HTML</p>"
    const result = normalizeIssue(raw, BASE_URL);
    expect(result.bodyMarkdown).toContain("Rendered description HTML");
  });

  it("falls back to empty string when renderedFields.description is absent", () => {
    const raw = makeRawIssue({ renderedFields: {} });
    const result = normalizeIssue(raw, BASE_URL);
    // No rendered HTML available → bodyMarkdown should be empty (htmlToMarkdown("") = "")
    expect(result.bodyMarkdown).toBe("");
  });

  it("falls back to empty string when renderedFields is entirely absent", () => {
    const raw = makeRawIssue({ renderedFields: undefined });
    const result = normalizeIssue(raw, BASE_URL);
    expect(result.bodyMarkdown).toBe("");
  });

  it("falls back to empty string when renderedFields.description is a non-string (ADF object)", () => {
    const raw = makeRawIssue({
      renderedFields: {
        description: { type: "doc", content: [] } as unknown as string,
      },
    });
    const result = normalizeIssue(raw, BASE_URL);
    // Non-string renderedFields.description → null in normalize.ts ~73-74 → ""
    expect(result.bodyMarkdown).toBe("");
  });

  it("truncates bodyMarkdown to bodyMaxChars", () => {
    const longHtml = `<p>${"A".repeat(10_000)}</p>`;
    const raw = makeRawIssue({ renderedFields: { description: longHtml } });
    const result = normalizeIssue(raw, BASE_URL, [], 100);
    expect(result.bodyMarkdown.length).toBeGreaterThan(100); // includes truncation note
    expect(result.bodyMarkdown).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// normalizeIssue — include: comments (with renderedFields index-pairing)
// ---------------------------------------------------------------------------

describe("normalizeIssue – include:comments", () => {
  it("populates comments array when flag is set", () => {
    const result = normalizeIssue(makeRawIssue(), BASE_URL, ["comments"]);
    expect(result.comments).toHaveLength(2);
  });

  it("uses renderedBody from renderedFields.comment.comments for bodyMarkdown", () => {
    const result = normalizeIssue(makeRawIssue(), BASE_URL, ["comments"]);
    expect(result.comments![0]!.bodyMarkdown).toContain("Rendered first comment");
    expect(result.comments![1]!.bodyMarkdown).toContain("Rendered second comment");
  });

  it("pairs author + created from fields.comment.comments[i] (not renderedFields)", () => {
    // Author/when come from fields.comment.comments[i] (raw side),
    // while bodyMarkdown comes from renderedFields.comment.comments[i].renderedBody.
    const result = normalizeIssue(makeRawIssue(), BASE_URL, ["comments"]);
    expect(result.comments![0]!.author).toBe("Alice Smith");
    expect(result.comments![0]!.when).toBe("2024-01-01T10:00:00.000Z");
    expect(result.comments![1]!.author).toBe("Bob Jones");
    expect(result.comments![1]!.when).toBe("2024-01-02T12:00:00.000Z");
  });

  it("falls back to unknown author when fields.comment is absent", () => {
    const raw = makeRawIssue({
      fields: {
        ...makeRawIssue().fields,
        comment: undefined,
      },
    });
    // renderedFields still has comments but fields.comment is gone
    const result = normalizeIssue(raw, BASE_URL, ["comments"]);
    // Each comment should fall back to author "unknown"
    result.comments?.forEach((c) => {
      expect(c.author).toBe("unknown");
    });
  });

  it("returns empty comments array when both rendered and raw comments are absent", () => {
    const raw = makeRawIssue({
      fields: { ...makeRawIssue().fields, comment: undefined },
      renderedFields: { description: "<p>desc</p>" },
    });
    const result = normalizeIssue(raw, BASE_URL, ["comments"]);
    expect(result.comments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeIssue — include: attachments
// ---------------------------------------------------------------------------

describe("normalizeIssue – include:attachments", () => {
  it("populates attachments metadata when flag is set", () => {
    const result = normalizeIssue(makeRawIssue(), BASE_URL, ["attachments"]);
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments![0]).toEqual({
      id: "att-1",
      filename: "screenshot.png",
      mime: "image/png",
      size: 12345,
      downloadUrl: "https://…/screenshot.png",
    });
    expect(result.attachments![1]).toEqual({
      id: "att-2",
      filename: "notes.txt",
      mime: "text/plain",
      size: 500,
      downloadUrl: "https://…/notes.txt",
    });
  });

  it("returns empty attachments array when fields.attachment is absent", () => {
    const raw = makeRawIssue({
      fields: { ...makeRawIssue().fields, attachment: undefined },
    });
    const result = normalizeIssue(raw, BASE_URL, ["attachments"]);
    expect(result.attachments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeIssue — include: history (slice(-10))
// ---------------------------------------------------------------------------

describe("normalizeIssue – include:history", () => {
  it("populates history when flag is set", () => {
    const result = normalizeIssue(makeRawIssue(), BASE_URL, ["history"]);
    expect(result.history).toBeDefined();
  });

  it("limits history to the last 10 entries (slice(-10))", () => {
    // Fixture has 15 history entries; only the last 10 should be returned.
    const result = normalizeIssue(makeRawIssue(), BASE_URL, ["history"]);
    expect(result.history).toHaveLength(10);
    // The last entry in the fixture is index 14 (User 14, day 15)
    expect(result.history![9]!.author).toBe("User 14");
  });

  it("formats history entries with field/from/to summary", () => {
    const result = normalizeIssue(makeRawIssue(), BASE_URL, ["history"]);
    const entry = result.history![0]!;
    expect(entry.summary).toContain("status");
    expect(entry.summary).toContain("To Do");
    expect(entry.summary).toContain("In Progress");
  });

  it("returns empty history when changelog is absent", () => {
    const raw = makeRawIssue({ changelog: undefined });
    const result = normalizeIssue(raw, BASE_URL, ["history"]);
    expect(result.history).toEqual([]);
  });

  it("returns empty history when changelog.histories is empty", () => {
    const raw = makeRawIssue({ changelog: { histories: [] } });
    const result = normalizeIssue(raw, BASE_URL, ["history"]);
    expect(result.history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeIssue — multiple include flags together
// ---------------------------------------------------------------------------

describe("normalizeIssue – multiple include flags", () => {
  it("populates all three sections when all flags are specified", () => {
    const result = normalizeIssue(makeRawIssue(), BASE_URL, ["comments", "attachments", "history"]);
    expect(result.comments).toBeDefined();
    expect(result.attachments).toBeDefined();
    expect(result.history).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// normalizePage — lean output
// ---------------------------------------------------------------------------

describe("normalizePage – lean output (no include flags)", () => {
  it("produces correct ref, url, title, labels, bodyMarkdown", () => {
    const result = normalizePage(makeRawPage(), BASE_URL);
    expect(result.ref).toBe("123456789");
    expect(result.url).toBe("https://test.atlassian.net/wiki/spaces/DEV/pages/123456789/Architecture+Overview");
    expect(result.title).toBe("Architecture Overview");
    expect(result.labels).toEqual(["architecture", "platform"]);
    expect(result.bodyMarkdown).toContain("Architecture");
  });

  it("uses an absolute webui URL as-is", () => {
    const raw = makeRawPage({ _links: { webui: "https://example.atlassian.net/wiki/spaces/DEV/pages/1" } });
    const result = normalizePage(raw, BASE_URL);
    expect(result.url).toBe("https://example.atlassian.net/wiki/spaces/DEV/pages/1");
  });

  it("prepends baseUrl/wiki when webui is a relative path", () => {
    const raw = makeRawPage({ _links: { webui: "/spaces/DEV/pages/1" } });
    const result = normalizePage(raw, BASE_URL);
    expect(result.url).toBe(`${BASE_URL}/wiki/spaces/DEV/pages/1`);
  });

  it("handles missing _links gracefully", () => {
    const raw = makeRawPage({ _links: undefined });
    const result = normalizePage(raw, BASE_URL);
    expect(result.url).toBe(`${BASE_URL}/wiki`);
  });

  it("does NOT include comments, attachments, or history by default", () => {
    const result = normalizePage(makeRawPage(), BASE_URL);
    expect(result.comments).toBeUndefined();
    expect(result.attachments).toBeUndefined();
    expect(result.history).toBeUndefined();
  });

  it("returns empty labels array when metadata.labels is absent", () => {
    const raw = makeRawPage({ metadata: undefined });
    const result = normalizePage(raw, BASE_URL);
    expect(result.labels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizePage — include flags (Phase B: comments/attachments return [] by design)
// ---------------------------------------------------------------------------

describe("normalizePage – include flags", () => {
  it("returns empty comments array when comments flag is set (Phase B deferred)", () => {
    const result = normalizePage(makeRawPage(), BASE_URL, ["comments"]);
    expect(result.comments).toEqual([]);
  });

  it("returns empty attachments array when attachments flag is set (Phase B deferred)", () => {
    const result = normalizePage(makeRawPage(), BASE_URL, ["attachments"]);
    expect(result.attachments).toEqual([]);
  });

  it("returns single-entry history from version field when history flag is set", () => {
    const result = normalizePage(makeRawPage(), BASE_URL, ["history"]);
    expect(result.history).toHaveLength(1);
    expect(result.history![0]!.author).toBe("user-abc");
    expect(result.history![0]!.when).toBe("2024-03-01T09:00:00.000Z");
    expect(result.history![0]!.summary).toContain("version 5");
  });

  it("returns empty history when version is absent", () => {
    const raw = makeRawPage({ version: undefined });
    const result = normalizePage(raw, BASE_URL, ["history"]);
    expect(result.history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeJiraSearchResults
// ---------------------------------------------------------------------------

describe("normalizeJiraSearchResults", () => {
  it("maps issues to key/summary/status/type shape", () => {
    const raw: RawJiraSearchResult = {
      issues: [
        { key: "PROJ-1", fields: { summary: "First issue", status: { name: "Open" }, issuetype: { name: "Task" } } },
        { key: "PROJ-2", fields: { summary: "Second issue", status: { name: "Done" }, issuetype: { name: "Story" } } },
      ],
    };
    const hits = normalizeJiraSearchResults(raw);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ key: "PROJ-1", summary: "First issue", status: "Open", type: "Task" });
    expect(hits[1]).toEqual({ key: "PROJ-2", summary: "Second issue", status: "Done", type: "Story" });
  });

  it("returns empty array for zero issues", () => {
    expect(normalizeJiraSearchResults({ issues: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeConfluenceSearchResults
// ---------------------------------------------------------------------------

describe("normalizeConfluenceSearchResults", () => {
  it("maps search results to id/title/space/url shape", () => {
    const raw: RawConfluenceSearchResult = {
      results: [
        {
          content: {
            id: "111",
            title: "My Page",
            type: "page",
            _links: { webui: "/wiki/spaces/DEV/pages/111/My+Page" },
          },
        },
      ],
    };
    const hits = normalizeConfluenceSearchResults(raw, BASE_URL);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe("111");
    expect(hits[0]!.title).toBe("My Page");
    expect(hits[0]!.url).toBe(`${BASE_URL}/wiki/wiki/spaces/DEV/pages/111/My+Page`);
  });

  it("uses absolute webui URL as-is", () => {
    const raw: RawConfluenceSearchResult = {
      results: [
        {
          content: {
            id: "222",
            title: "Absolute Page",
            type: "page",
            _links: { webui: "https://acme.atlassian.net/wiki/spaces/X/pages/222" },
          },
        },
      ],
    };
    const hits = normalizeConfluenceSearchResults(raw, BASE_URL);
    expect(hits[0]!.url).toBe("https://acme.atlassian.net/wiki/spaces/X/pages/222");
  });

  it("falls back to resultGlobalContainer displayUrl when content._links is absent", () => {
    const raw: RawConfluenceSearchResult = {
      results: [
        {
          content: { id: "333", title: "Fallback", type: "page" },
          resultGlobalContainer: { displayUrl: "/wiki/spaces/FB/pages/333" },
        },
      ],
    };
    const hits = normalizeConfluenceSearchResults(raw, BASE_URL);
    expect(hits[0]!.url).toBe(`${BASE_URL}/wiki/wiki/spaces/FB/pages/333`);
  });

  it("returns empty array for zero results", () => {
    expect(normalizeConfluenceSearchResults({ results: [] }, BASE_URL)).toEqual([]);
  });
});
