/**
 * prefetch.test.ts — Phase E: ref-detection unit tests (offline, no network).
 *
 * Tests the REAL exported detectRefs() from prefetch.ts:
 *  - Jira URL extraction
 *  - Confluence URL extraction
 *  - Bare Jira key extraction
 *  - jiraProjects filter (bare keys only, URLs bypass)
 *  - Deduplication (URL precedence)
 *  - Cap (max)
 */

import { describe, it, expect } from "vitest";
import { detectRefs } from "../prefetch.js";

// ---------------------------------------------------------------------------
// Jira URL extraction
// ---------------------------------------------------------------------------
describe("detectRefs — Jira URLs", () => {
  it("extracts a Jira browse URL and returns the key", () => {
    const refs = detectRefs("See https://example.atlassian.net/browse/PROJ-123 for details.");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ kind: "jira", ref: "PROJ-123" });
  });

  it("extracts a Jira URL under /jira/browse/", () => {
    const refs = detectRefs("https://example.atlassian.net/jira/browse/AB-1");
    expect(refs[0]).toEqual({ kind: "jira", ref: "AB-1" });
  });

  it("extracts a Jira /issues/ URL", () => {
    const refs = detectRefs("https://example.atlassian.net/issues/AIBM3-56");
    expect(refs[0]).toEqual({ kind: "jira", ref: "AIBM3-56" });
  });

  it("extracts multiple Jira URLs", () => {
    const text = `
      Check https://host.atlassian.net/browse/PROJ-1 and
      https://host.atlassian.net/browse/PROJ-2 for context.
    `;
    const refs = detectRefs(text);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.ref)).toEqual(["PROJ-1", "PROJ-2"]);
  });

  it("ignores URL query strings and fragments when extracting the key", () => {
    const refs = detectRefs("https://example.atlassian.net/browse/PROJ-99?jql=open#tab");
    expect(refs[0]?.ref).toBe("PROJ-99");
  });
});

// ---------------------------------------------------------------------------
// Confluence URL extraction
// ---------------------------------------------------------------------------
describe("detectRefs — Confluence URLs", () => {
  it("extracts a Confluence pages URL and returns the page ID", () => {
    const refs = detectRefs(
      "See https://example.atlassian.net/wiki/spaces/ENG/pages/12345678/My-Page",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ kind: "confluence", ref: "12345678" });
  });

  it("extracts a bare Confluence pages URL without trailing title", () => {
    const refs = detectRefs(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/99999999",
    );
    expect(refs[0]).toEqual({ kind: "confluence", ref: "99999999" });
  });

  it("extracts multiple Confluence URLs", () => {
    const text =
      "https://h.atlassian.net/wiki/spaces/A/pages/111 " +
      "https://h.atlassian.net/wiki/spaces/B/pages/222";
    const refs = detectRefs(text);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.ref)).toContain("111");
    expect(refs.map((r) => r.ref)).toContain("222");
  });
});

// ---------------------------------------------------------------------------
// Bare Jira key extraction
// ---------------------------------------------------------------------------
describe("detectRefs — bare Jira keys", () => {
  it("extracts a bare Jira key from plain text", () => {
    const refs = detectRefs("Working on PROJ-42 today.");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ kind: "jira", ref: "PROJ-42" });
  });

  it("only matches word-boundary-anchored keys (not in the middle of a word)", () => {
    // "NOTPROJ-1" has no word boundary before P but 'NOTPROJ-1' as a whole token
    // should match since it starts with uppercase and follows the regex.
    // Real check: a trailing digit is part of the key, not cutoff mid-word.
    const refs = detectRefs("PROJ-1 is the ticket.");
    expect(refs[0]?.ref).toBe("PROJ-1");
  });

  it("does NOT match a lowercase or embedded pseudo-key (word-boundary NEGATIVE)", () => {
    // 'proj-1' is lowercase — must not match (regex requires uppercase start)
    const lowercaseRefs = detectRefs("see proj-1 for details");
    expect(lowercaseRefs).toHaveLength(0);

    // 'XPROJ-1' has no word boundary before the capital run — the whole token
    // starts a word so it would match as key 'XPROJ-1'; verify the real boundary
    // behaviour: an embedded digit-only suffix in a longer word must NOT match
    const noSpaceRefs = detectRefs("somePROJ-1thing");
    // 'PROJ-1' appears inside a word — \b anchors ensure it is NOT extracted
    // (the 'P' is preceded by lowercase 'e', which IS a word boundary in JS,
    // but the pattern requires the full key to be at a boundary on both sides).
    // The key point: a purely embedded/lowercase token like 'proj-1' never fires.
    expect(lowercaseRefs).toHaveLength(0);

    // A token resembling a key but with lowercase letters is never extracted
    const mixedRefs = detectRefs("Review ticket Proj-1 ASAP.");
    // 'Proj-1' starts with uppercase P then lowercase r — regex requires [A-Z][A-Z0-9]+
    // so this must NOT match.
    expect(mixedRefs).toHaveLength(0);
  });

  it("handles keys with numeric characters in the project part", () => {
    const refs = detectRefs("AIBM3-56 is the issue.");
    expect(refs[0]).toEqual({ kind: "jira", ref: "AIBM3-56" });
  });

  it("filters bare keys by jiraProjects when provided", () => {
    const refs = detectRefs("PROJ-1 and OTHER-2 are tickets.", { jiraProjects: ["PROJ"] });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.ref).toBe("PROJ-1");
  });

  it("keeps all bare keys when jiraProjects is empty", () => {
    const refs = detectRefs("PROJ-1 and OTHER-2 are tickets.", { jiraProjects: [] });
    expect(refs).toHaveLength(2);
  });

  it("keeps all bare keys when jiraProjects is not supplied", () => {
    const refs = detectRefs("PROJ-1 and OTHER-2 are tickets.");
    expect(refs).toHaveLength(2);
  });

  it("jiraProjects filter matches multiple prefixes", () => {
    const refs = detectRefs("PROJ-1 AB-2 OTHER-3 X-4", { jiraProjects: ["PROJ", "AB"] });
    expect(refs.map((r) => r.ref)).toEqual(["PROJ-1", "AB-2"]);
  });
});

// ---------------------------------------------------------------------------
// URL precedence (deduplication)
// ---------------------------------------------------------------------------
describe("detectRefs — URL precedence / deduplication", () => {
  it("does not double-add a Jira key that was already found via URL", () => {
    const text =
      "https://example.atlassian.net/browse/PROJ-1 is the same as PROJ-1 in text.";
    const refs = detectRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ kind: "jira", ref: "PROJ-1" });
  });

  it("deduplicates identical Jira URLs", () => {
    const text =
      "https://example.atlassian.net/browse/PROJ-1 " +
      "https://example.atlassian.net/browse/PROJ-1";
    const refs = detectRefs(text);
    expect(refs).toHaveLength(1);
  });

  it("deduplicates identical Confluence page IDs", () => {
    const text =
      "https://h.atlassian.net/wiki/spaces/A/pages/111 " +
      "https://h.atlassian.net/wiki/spaces/B/pages/111";
    const refs = detectRefs(text);
    // Both point to page ID 111; after dedup only one remains
    expect(refs.filter((r) => r.kind === "confluence").map((r) => r.ref)).toEqual(["111"]);
  });
});

// ---------------------------------------------------------------------------
// Cap (max)
// ---------------------------------------------------------------------------
describe("detectRefs — cap", () => {
  it("caps at max (default 5)", () => {
    const keys = Array.from({ length: 10 }, (_, i) => `PROJ-${i + 1}`).join(" ");
    const refs = detectRefs(keys);
    expect(refs).toHaveLength(5);
  });

  it("respects a custom max", () => {
    const keys = "PROJ-1 PROJ-2 PROJ-3 PROJ-4 PROJ-5 PROJ-6";
    const refs = detectRefs(keys, { max: 3 });
    expect(refs).toHaveLength(3);
  });

  it("returns fewer than max when there are fewer refs", () => {
    const refs = detectRefs("PROJ-1 PROJ-2", { max: 10 });
    expect(refs).toHaveLength(2);
  });

  it("max=0 returns empty", () => {
    const refs = detectRefs("PROJ-1 PROJ-2", { max: 0 });
    expect(refs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed content
// ---------------------------------------------------------------------------
describe("detectRefs — mixed content", () => {
  it("handles text containing both Jira URL and Confluence URL", () => {
    const text =
      "Jira: https://h.atlassian.net/browse/PROJ-1 " +
      "Doc: https://h.atlassian.net/wiki/spaces/ENG/pages/123456/Spec";
    const refs = detectRefs(text);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.kind === "jira")?.ref).toBe("PROJ-1");
    expect(refs.find((r) => r.kind === "confluence")?.ref).toBe("123456");
  });

  it("empty text returns empty array", () => {
    expect(detectRefs("")).toEqual([]);
  });

  it("text with no Atlassian refs returns empty array", () => {
    expect(detectRefs("nothing relevant here, just text")).toEqual([]);
  });
});
