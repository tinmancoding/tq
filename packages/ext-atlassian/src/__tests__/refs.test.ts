/**
 * refs.test.ts — unit tests for parseRef and extractRefs.
 */

import { describe, it, expect } from "vitest";
import { parseRef, extractRefs } from "../refs.js";

// ---------------------------------------------------------------------------
// parseRef
// ---------------------------------------------------------------------------

describe("parseRef", () => {
  // Jira URL forms
  it("parses a standard Jira browse URL", () => {
    const ref = parseRef("https://acme.atlassian.net/browse/PROJ-123");
    expect(ref).toEqual({ kind: "jira", key: "PROJ-123" });
  });

  it("parses a Jira URL with /jira/ prefix", () => {
    const ref = parseRef("https://acme.atlassian.net/jira/browse/AIBM3-456");
    expect(ref).toEqual({ kind: "jira", key: "AIBM3-456" });
  });

  it("parses a Jira URL with query params", () => {
    const ref = parseRef("https://acme.atlassian.net/browse/PROJ-1?focusedCommentId=123");
    expect(ref).toEqual({ kind: "jira", key: "PROJ-1" });
  });

  // Confluence URL forms
  it("parses a Confluence page URL", () => {
    const ref = parseRef(
      "https://acme.atlassian.net/wiki/spaces/SPACE/pages/12345678/Some-Page-Title",
    );
    expect(ref).toEqual({ kind: "confluence", id: "12345678" });
  });

  it("parses a Confluence page URL without title slug", () => {
    const ref = parseRef("https://acme.atlassian.net/wiki/spaces/ENG/pages/99999");
    expect(ref).toEqual({ kind: "confluence", id: "99999" });
  });

  it("parses a Confluence URL with query params", () => {
    const ref = parseRef(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/99999?src=search",
    );
    expect(ref).toEqual({ kind: "confluence", id: "99999" });
  });

  // Bare Jira key
  it("parses a bare Jira key", () => {
    expect(parseRef("PROJ-123")).toEqual({ kind: "jira", key: "PROJ-123" });
    expect(parseRef("AB-1")).toEqual({ kind: "jira", key: "AB-1" });
    expect(parseRef("AIBM3-456")).toEqual({ kind: "jira", key: "AIBM3-456" });
  });

  // Numeric Confluence page ID
  it("parses a numeric Confluence page id", () => {
    expect(parseRef("12345678")).toEqual({ kind: "confluence", id: "12345678" });
  });

  // Unrecognised / null cases
  it("returns null for empty string", () => {
    expect(parseRef("")).toBeNull();
    expect(parseRef("   ")).toBeNull();
  });

  it("returns null for random text", () => {
    expect(parseRef("not-a-ref")).toBeNull();
    expect(parseRef("https://example.com")).toBeNull();
  });

  it("returns null for lowercase key (not a Jira key)", () => {
    expect(parseRef("proj-123")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractRefs
// ---------------------------------------------------------------------------

describe("extractRefs", () => {
  it("extracts a Jira URL from text", () => {
    const refs = extractRefs(
      "See https://acme.atlassian.net/browse/PROJ-1 for details.",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ kind: "jira", key: "PROJ-1" });
  });

  it("extracts a Confluence URL from text", () => {
    const refs = extractRefs(
      "Doc: https://acme.atlassian.net/wiki/spaces/ENG/pages/12345678/Design",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ kind: "confluence", id: "12345678" });
  });

  it("extracts bare Jira keys from text", () => {
    const refs = extractRefs("I fixed PROJ-10 and PROJ-11 today.");
    expect(refs).toContainEqual({ kind: "jira", key: "PROJ-10" });
    expect(refs).toContainEqual({ kind: "jira", key: "PROJ-11" });
  });

  it("extracts both URLs and bare keys", () => {
    const text =
      "URL: https://acme.atlassian.net/browse/PROJ-5 and bare key PROJ-6";
    const refs = extractRefs(text);
    const keys = refs.map((r) => (r.kind === "jira" ? r.key : r.id));
    expect(keys).toContain("PROJ-5");
    expect(keys).toContain("PROJ-6");
  });

  it("deduplicates refs — URL and bare key for same issue count once", () => {
    const text =
      "https://acme.atlassian.net/browse/PROJ-1 and PROJ-1 again";
    const refs = extractRefs(text);
    const jiraRefs = refs.filter((r) => r.kind === "jira" && r.key === "PROJ-1");
    expect(jiraRefs).toHaveLength(1);
  });

  it("deduplicates bare keys that appear multiple times", () => {
    const refs = extractRefs("PROJ-1 PROJ-1 PROJ-1");
    expect(refs).toHaveLength(1);
  });

  it("applies project-prefix filter for bare keys", () => {
    const refs = extractRefs("PROJ-1 OTHER-2 AB-3", { jiraProjects: ["PROJ", "AB"] });
    const keys = refs.map((r) => (r.kind === "jira" ? r.key : r.id));
    expect(keys).toContain("PROJ-1");
    expect(keys).toContain("AB-3");
    expect(keys).not.toContain("OTHER-2");
  });

  it("does NOT filter URL-based Jira refs by project prefix", () => {
    const refs = extractRefs(
      "https://acme.atlassian.net/browse/OTHER-99",
      { jiraProjects: ["PROJ"] },
    );
    expect(refs).toContainEqual({ kind: "jira", key: "OTHER-99" });
  });

  it("caps results at the default cap of 5", () => {
    const text = "PROJ-1 PROJ-2 PROJ-3 PROJ-4 PROJ-5 PROJ-6 PROJ-7";
    const refs = extractRefs(text);
    expect(refs.length).toBeLessThanOrEqual(5);
  });

  it("respects a custom cap", () => {
    const text = "PROJ-1 PROJ-2 PROJ-3 PROJ-4 PROJ-5 PROJ-6 PROJ-7";
    const refs = extractRefs(text, { cap: 3 });
    expect(refs).toHaveLength(3);
  });

  it("returns empty array for text with no refs", () => {
    expect(extractRefs("No refs here, just plain text.")).toEqual([]);
    expect(extractRefs("")).toEqual([]);
  });

  it("handles mixed Jira+Confluence refs up to cap", () => {
    const text = [
      "https://acme.atlassian.net/browse/PROJ-1",
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/11111/Design",
      "PROJ-2",
      "PROJ-3",
      "PROJ-4",
      "PROJ-5",
    ].join(" ");
    const refs = extractRefs(text, { cap: 5 });
    expect(refs).toHaveLength(5);
  });

  it("does not match partial key-like strings inside words (word-boundary)", () => {
    // "NOPROJ-1" should not match bare-key if it's embedded in a word (depends on boundary)
    // "PROJ-1" in "ticket-PROJ-1-end" — the \b boundary should still catch it
    const refs = extractRefs("ticket PROJ-1 done");
    expect(refs).toContainEqual({ kind: "jira", key: "PROJ-1" });
  });
});
