/**
 * pi-engine.test.ts — Phase D engine tests (offline, no AWS credentials).
 *
 * Tests the REAL exported pure helpers from pi-engine.ts:
 *  • overBudget / budgetResult       — budget boundary logic
 *  • toToolText                       — result serialization
 *  • attachmentToToolContent          — attachment result → LLM content blocks
 *  • resolveThinkingLevel             — allow-list validation
 *  • buildToolNames                   — tool-registration gating
 *
 * Also tests the REAL buildAtlassianClosures (from extension.ts) against a
 * stubbed core.request that throws — verifying the fail-safe path returns
 * '[<tool> error] <message>' without propagating the exception.
 *
 * Phase E additions:
 *  • buildReferencedContextBlock      — referenced context prompt injection
 *  • buildPrefetchTraceSteps          — synthetic trace step generation
 */

import { describe, it, expect, vi } from "vitest";
import {
  BUDGET_MSG,
  overBudget,
  budgetResult,
  toToolText,
  attachmentToToolContent,
  resolveThinkingLevel,
  buildToolNames,
  buildReferencedContextBlock,
  buildPrefetchTraceSteps,
  runPrefetch,
  type BudgetCounter,
} from "../pi-engine.js";
import { buildAtlassianClosures } from "../extension.js";
import type { AttachmentResult } from "../engine.js";
import type { CoreClient } from "@tq/contract";

// ---------------------------------------------------------------------------
// overBudget + budgetResult
// ---------------------------------------------------------------------------

describe("overBudget", () => {
  it("returns false for the first N calls up to the budget ceiling", () => {
    const counter: BudgetCounter = { value: 0 };
    for (let i = 0; i < 5; i++) {
      expect(overBudget(counter, 5)).toBe(false);
    }
    expect(counter.value).toBe(5);
  });

  it("returns true on the call immediately exceeding the ceiling (boundary)", () => {
    const counter: BudgetCounter = { value: 0 };
    // Exhaust exactly at ceiling (budget=3, call 1-3 are in-budget)
    overBudget(counter, 3); // call 1 → false
    overBudget(counter, 3); // call 2 → false
    overBudget(counter, 3); // call 3 → false
    expect(overBudget(counter, 3)).toBe(true); // call 4 → over budget
  });

  it("continues returning true for every subsequent call past the ceiling", () => {
    const counter: BudgetCounter = { value: 10 };
    expect(overBudget(counter, 5)).toBe(true);
    expect(overBudget(counter, 5)).toBe(true);
  });

  it("increments the counter even when budget is exceeded", () => {
    const counter: BudgetCounter = { value: 5 };
    overBudget(counter, 3);
    expect(counter.value).toBe(6);
  });

  it("budget=0 means the very first call is over-budget", () => {
    const counter: BudgetCounter = { value: 0 };
    expect(overBudget(counter, 0)).toBe(true);
  });
});

describe("budgetResult", () => {
  it("returns the canonical BUDGET_MSG in a text content block", () => {
    const result = budgetResult();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(BUDGET_MSG);
  });

  it("BUDGET_MSG mentions 'tool-call' and 'emit_triage'", () => {
    expect(BUDGET_MSG).toMatch(/tool-call/);
    expect(BUDGET_MSG).toMatch(/emit_triage/);
  });
});

// ---------------------------------------------------------------------------
// toToolText
// ---------------------------------------------------------------------------

describe("toToolText", () => {
  it("passes strings through unchanged", () => {
    expect(toToolText("hello")).toBe("hello");
  });

  it("serializes objects to pretty JSON", () => {
    const result = toToolText({ key: "PROJ-1", status: "Done" });
    expect(result).toContain('"key"');
    expect(result).toContain('"PROJ-1"');
  });

  it("serializes arrays", () => {
    const result = toToolText([1, 2, 3]);
    expect(JSON.parse(result)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// attachmentToToolContent
// ---------------------------------------------------------------------------

describe("attachmentToToolContent", () => {
  it("returns a text error block for an error string", () => {
    const blocks = attachmentToToolContent("[fetch_attachment error] timeout");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect((blocks[0]! as { type: "text"; text: string }).text).toBe(
      "[fetch_attachment error] timeout",
    );
  });

  it("returns a text block for a {text} result", () => {
    const result: AttachmentResult = { text: "Extracted PDF text" };
    const blocks = attachmentToToolContent(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect((blocks[0]! as { type: "text"; text: string }).text).toBe("Extracted PDF text");
  });

  it("returns a real ImageContent block for a {images} result", () => {
    const result: AttachmentResult = {
      images: [{ mime: "image/png", dataBase64: "abc123==" }],
    };
    const blocks = attachmentToToolContent(result);
    expect(blocks).toHaveLength(1);
    const block = blocks[0]! as { type: "image"; data: string; mimeType: string };
    expect(block.type).toBe("image");
    expect(block.data).toBe("abc123==");
    expect(block.mimeType).toBe("image/png");
  });

  it("returns both text and image blocks when both are present", () => {
    const result: AttachmentResult = {
      text: "Caption text",
      images: [{ mime: "image/jpeg", dataBase64: "xyz==" }],
    };
    const blocks = attachmentToToolContent(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[1]!.type).toBe("image");
  });

  it("returns a fallback '(no extractable content)' block for an empty result", () => {
    const result: AttachmentResult = {};
    const blocks = attachmentToToolContent(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect((blocks[0]! as { type: "text"; text: string }).text).toContain("no extractable content");
  });

  it("handles multiple images", () => {
    const result: AttachmentResult = {
      images: [
        { mime: "image/png", dataBase64: "a==" },
        { mime: "image/png", dataBase64: "b==" },
      ],
    };
    const blocks = attachmentToToolContent(result);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.type === "image")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveThinkingLevel
// ---------------------------------------------------------------------------

describe("resolveThinkingLevel", () => {
  it.each(["off", "minimal", "low", "medium", "high", "xhigh"] as const)(
    "accepts valid level '%s' unchanged",
    (level) => {
      expect(resolveThinkingLevel(level)).toBe(level);
    },
  );

  it("falls back to 'low' for an unrecognised level", () => {
    expect(resolveThinkingLevel("turbo")).toBe("low");
    expect(resolveThinkingLevel("ultra")).toBe("low");
  });

  it("falls back to 'low' for undefined", () => {
    expect(resolveThinkingLevel(undefined)).toBe("low");
  });

  it("falls back to 'low' for empty string", () => {
    expect(resolveThinkingLevel("")).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// buildToolNames — tool-registration gating
// ---------------------------------------------------------------------------

describe("buildToolNames", () => {
  it("returns only core tools when atlassianEnabled=false", () => {
    const names = buildToolNames(false);
    expect(names).toEqual(["search_tasks", "emit_triage"]);
  });

  it("returns 7 tools when atlassianEnabled=true", () => {
    const names = buildToolNames(true);
    expect(names).toHaveLength(7);
    expect(names).toContain("jira_get");
    expect(names).toContain("jira_search");
    expect(names).toContain("confluence_get");
    expect(names).toContain("confluence_search");
    expect(names).toContain("fetch_attachment");
  });

  it("always includes search_tasks and emit_triage", () => {
    for (const enabled of [true, false]) {
      const names = buildToolNames(enabled);
      expect(names).toContain("search_tasks");
      expect(names).toContain("emit_triage");
    }
  });
});

// ---------------------------------------------------------------------------
// buildAtlassianClosures — fail-safe path (real function, stubbed CoreClient)
// ---------------------------------------------------------------------------

describe("buildAtlassianClosures — fail-safe paths", () => {
  function makeCoreClient(impl?: Partial<CoreClient>): CoreClient {
    return {
      request: vi.fn().mockRejectedValue(new Error("connection refused")),
      tasks: {} as CoreClient["tasks"],
      intake: {} as CoreClient["intake"],
      context: {} as CoreClient["context"],
      search: vi.fn(),
      ...impl,
    } as unknown as CoreClient;
  }

  it("jira_get returns '[jira_get error] ...' when core.request throws", async () => {
    const core = makeCoreClient();
    const closures = buildAtlassianClosures(core);
    const result = await closures.jira_get("PROJ-1");
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/^\[jira_get error\]/);
    expect(result as string).toContain("connection refused");
  });

  it("jira_search returns '[jira_search error] ...' when core.request throws", async () => {
    const core = makeCoreClient();
    const closures = buildAtlassianClosures(core);
    const result = await closures.jira_search("project = PROJ", 5);
    expect(result as string).toMatch(/^\[jira_search error\]/);
  });

  it("confluence_get returns '[confluence_get error] ...' when core.request throws", async () => {
    const core = makeCoreClient();
    const closures = buildAtlassianClosures(core);
    const result = await closures.confluence_get("12345");
    expect(result as string).toMatch(/^\[confluence_get error\]/);
  });

  it("confluence_search returns '[confluence_search error] ...' when core.request throws", async () => {
    const core = makeCoreClient();
    const closures = buildAtlassianClosures(core);
    const result = await closures.confluence_search("text ~ foo", 5);
    expect(result as string).toMatch(/^\[confluence_search error\]/);
  });

  it("fetch_attachment returns '[fetch_attachment error] ...' when core.request throws", async () => {
    const core = makeCoreClient();
    const closures = buildAtlassianClosures(core);
    const result = await closures.fetch_attachment(
      "https://example.atlassian.net/wiki/download/attachments/1/file.pdf",
      "application/pdf",
    );
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/^\[fetch_attachment error\]/);
  });

  it("closures do not throw — always return a string on error", async () => {
    const core = makeCoreClient({
      request: vi.fn().mockRejectedValue(new TypeError("network failure")),
    });
    const closures = buildAtlassianClosures(core);
    // None of these should throw; all should return string
    const results = await Promise.all([
      closures.jira_get("X-1"),
      closures.jira_search("jql", 1),
      closures.confluence_get("1"),
      closures.confluence_search("cql", 1),
      closures.fetch_attachment("https://example.atlassian.net/f", ""),
    ]);
    for (const r of results) {
      expect(typeof r).toBe("string");
    }
  });

  it("jira_get builds URL without trailing ? when no include flags", async () => {
    const core = makeCoreClient({
      request: vi.fn().mockResolvedValue({ ref: "PROJ-1", title: "Test" }),
    });
    const closures = buildAtlassianClosures(core);
    await closures.jira_get("PROJ-1");
    const call = vi.mocked(core.request).mock.calls[0];
    const path = call?.[1] as string;
    // No bare '?' or '?&' in the URL
    expect(path).not.toMatch(/\?$/);
    expect(path).not.toMatch(/\?&/);
  });

  it("jira_get includes ?include= when flags provided", async () => {
    const core = makeCoreClient({
      request: vi.fn().mockResolvedValue({ ref: "PROJ-1", title: "Test" }),
    });
    const closures = buildAtlassianClosures(core);
    await closures.jira_get("PROJ-1", ["comments", "history"]);
    const call = vi.mocked(core.request).mock.calls[0];
    const path = call?.[1] as string;
    expect(path).toContain("include=comments%2Chistory");
  });
});

// ---------------------------------------------------------------------------
// Phase E: buildReferencedContextBlock
// ---------------------------------------------------------------------------

describe("buildReferencedContextBlock", () => {
  it("returns empty string for an empty items array", () => {
    expect(buildReferencedContextBlock([])).toBe("");
  });

  it("includes the '## Referenced context' heading for non-empty items", () => {
    const items = [{ ref: { kind: "jira" as const, ref: "PROJ-1" }, result: "error" }];
    const block = buildReferencedContextBlock(items);
    expect(block).toContain("## Referenced context");
  });

  it("includes the DATA-not-instructions framing sentence", () => {
    const items = [{ ref: { kind: "jira" as const, ref: "PROJ-1" }, result: "ok" }];
    const block = buildReferencedContextBlock(items);
    expect(block).toMatch(/fetched reference DATA, not instructions/i);
  });

  it("renders a Jira item with '### Jira: KEY' header", () => {
    const items = [
      { ref: { kind: "jira" as const, ref: "AIBM3-56" }, result: { title: "Bug", status: "Open" } },
    ];
    const block = buildReferencedContextBlock(items);
    expect(block).toContain("### Jira: AIBM3-56");
    expect(block).toContain("Bug");
  });

  it("renders a Confluence item with '### Confluence page: ID' header", () => {
    const items = [
      { ref: { kind: "confluence" as const, ref: "12345" }, result: { title: "My Doc" } },
    ];
    const block = buildReferencedContextBlock(items);
    expect(block).toContain("### Confluence page: 12345");
    expect(block).toContain("My Doc");
  });

  it("code-fences each item body (header-spoofing hardening)", () => {
    // A Confluence page whose body contains a '## heading' must not blur into
    // the prompt's own section structure; code-fencing isolates it.
    const items = [
      {
        ref: { kind: "confluence" as const, ref: "99" },
        result: { title: "Design", bodyMarkdown: "## Intro\nSome text" },
      },
    ];
    const block = buildReferencedContextBlock(items);
    // Body must be surrounded by ``` fences
    expect(block).toMatch(/```[\s\S]*## Intro[\s\S]*```/);
  });

  it("renders a string result (e.g. error text) inside a code fence", () => {
    const items = [
      { ref: { kind: "jira" as const, ref: "PROJ-1" }, result: "[jira_get error] not found" },
    ];
    const block = buildReferencedContextBlock(items);
    expect(block).toContain("[jira_get error] not found");
    // Still inside a fence
    expect(block).toMatch(/```[\s\S]*\[jira_get error\][\s\S]*```/);
  });

  it("renders multiple items", () => {
    const items = [
      { ref: { kind: "jira" as const, ref: "PROJ-1" }, result: { title: "First" } },
      { ref: { kind: "confluence" as const, ref: "99" }, result: { title: "Second" } },
    ];
    const block = buildReferencedContextBlock(items);
    expect(block).toContain("### Jira: PROJ-1");
    expect(block).toContain("### Confluence page: 99");
  });

  // This test previously was a DUPLICATE empty-array check (mislabeled).
  // It now exercises the real atlassianEnabled=false gate via runPrefetch.
  it("no injection when atlassianEnabled=false (runPrefetch gate)", async () => {
    const fakeClosure = vi.fn().mockResolvedValue({ title: "Should not be called" });
    const result = await runPrefetch(
      "Check PROJ-1 for details.",
      "https://example.atlassian.net/browse/PROJ-2",
      { atlassianEnabled: false, jiraProjects: [], prefetchMax: 5 },
      { jira_get: fakeClosure, confluence_get: fakeClosure },
    );
    expect(result.referencedBlock).toBe("");
    expect(result.prefetchTraceSteps).toHaveLength(0);
    expect(fakeClosure).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase E: buildPrefetchTraceSteps
// ---------------------------------------------------------------------------

describe("buildPrefetchTraceSteps", () => {
  it("returns exactly two steps [tool_call, tool_result]", () => {
    const [tc, tr] = buildPrefetchTraceSteps({ kind: "jira", ref: "PROJ-1" }, { title: "Foo" });
    expect(tc.kind).toBe("tool_call");
    expect(tr.kind).toBe("tool_result");
  });

  it("both steps have tool='prefetch'", () => {
    const [tc, tr] = buildPrefetchTraceSteps({ kind: "jira", ref: "PROJ-1" }, { title: "Foo" });
    expect((tc as { tool: string }).tool).toBe("prefetch");
    expect((tr as { tool: string }).tool).toBe("prefetch");
  });

  it("tool_call args contains the ref string", () => {
    const [tc] = buildPrefetchTraceSteps({ kind: "confluence", ref: "12345" }, { title: "Doc" });
    expect((tc as { args: { ref: string } }).args.ref).toBe("12345");
  });

  it("ok=true for a successful object result", () => {
    const [, tr] = buildPrefetchTraceSteps(
      { kind: "jira", ref: "PROJ-1" },
      { title: "Bug", status: "Open" },
    );
    expect((tr as { ok: boolean }).ok).toBe(true);
  });

  it("ok=false for an error string", () => {
    const [, tr] = buildPrefetchTraceSteps(
      { kind: "jira", ref: "PROJ-1" },
      "[jira_get error] not found",
    );
    expect((tr as { ok: boolean }).ok).toBe(false);
  });

  it("text for a successful result includes title and status", () => {
    const [, tr] = buildPrefetchTraceSteps(
      { kind: "jira", ref: "PROJ-1" },
      { title: "My Bug", status: "In Progress" },
    );
    const text = (tr as { text: string }).text;
    expect(text).toContain("My Bug");
    expect(text).toContain("In Progress");
  });

  it("text for an error string is capped at 200 chars", () => {
    const longError = "[jira_get error] " + "x".repeat(300);
    const [, tr] = buildPrefetchTraceSteps({ kind: "jira", ref: "PROJ-1" }, longError);
    expect((tr as { text: string }).text.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Phase E: runPrefetch — REAL orchestration tests (criterion-1 / criterion-2)
// ---------------------------------------------------------------------------

describe("runPrefetch — real orchestration", () => {
  it("(a) detects refs in BOTH body and source_ref", async () => {
    // PROJ-1 is in body; PROJ-2 URL is in source_ref only.
    const jiraGet = vi.fn().mockResolvedValue({ title: "Issue", status: "Open" });
    const confGet = vi.fn().mockResolvedValue({ title: "Page" });

    const result = await runPrefetch(
      "Working on PROJ-1 today.",
      "https://host.atlassian.net/browse/PROJ-2",
      { atlassianEnabled: true, jiraProjects: [], prefetchMax: 5 },
      { jira_get: jiraGet, confluence_get: confGet },
    );

    // Both refs fetched
    expect(jiraGet).toHaveBeenCalledWith("PROJ-1");
    expect(jiraGet).toHaveBeenCalledWith("PROJ-2");
    expect(result.prefetchItems).toHaveLength(2);
    expect(result.referencedBlock).toContain("## Referenced context");
    expect(result.referencedBlock).toContain("### Jira: PROJ-1");
    expect(result.referencedBlock).toContain("### Jira: PROJ-2");
  });

  it("(b) atlassianEnabled=false → empty block, no steps, closures never called", async () => {
    const jiraGet = vi.fn();
    const result = await runPrefetch(
      "Check PROJ-1.",
      "",
      { atlassianEnabled: false, jiraProjects: [], prefetchMax: 5 },
      { jira_get: jiraGet, confluence_get: vi.fn() },
    );
    expect(result.referencedBlock).toBe("");
    expect(result.prefetchTraceSteps).toHaveLength(0);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it("(c) a THROWING closure is swallowed; other refs still yield items; pass continues", async () => {
    // PROJ-1 throws, PROJ-2 succeeds — two refs in body, cap 5.
    const jiraGet = vi.fn()
      .mockRejectedValueOnce(new Error("network timeout"))   // PROJ-1 → throw
      .mockResolvedValueOnce({ title: "Success", status: "Done" }); // PROJ-2 → ok

    await expect(
      runPrefetch(
        "PROJ-1 and PROJ-2 are both relevant.",
        "",
        { atlassianEnabled: true, jiraProjects: [], prefetchMax: 5 },
        { jira_get: jiraGet, confluence_get: vi.fn() },
      ),
    ).resolves.toBeDefined(); // does NOT reject

    // Both items in prefetchItems (one error, one success)
    const result = await runPrefetch(
      "PROJ-1 and PROJ-2 are both relevant.",
      "",
      { atlassianEnabled: true, jiraProjects: [], prefetchMax: 5 },
      {
        jira_get: vi.fn()
          .mockRejectedValueOnce(new Error("network timeout"))
          .mockResolvedValueOnce({ title: "Success", status: "Done" }),
        confluence_get: vi.fn(),
      },
    );
    expect(result.prefetchItems).toHaveLength(2);
    // The error item contains the [prefetch error] marker
    const errorItem = result.prefetchItems.find(
      (i) => typeof i.result === "string" && (i.result as string).includes("[prefetch error]"),
    );
    expect(errorItem).toBeDefined();
    // The success item contains the real object
    const successItem = result.prefetchItems.find(
      (i) => i.result && typeof i.result === "object",
    );
    expect(successItem).toBeDefined();
  });

  it("(c-variant) an ERROR-TEXT result is swallowed; trace ok=false; pass continues", async () => {
    // jira_get returns error text (not a throw) for PROJ-1
    const jiraGet = vi.fn()
      .mockResolvedValueOnce("[jira_get error] not found")  // PROJ-1 → error text
      .mockResolvedValueOnce({ title: "Found", status: "Open" }); // PROJ-2 → ok

    const result = await runPrefetch(
      "PROJ-1 PROJ-2",
      "",
      { atlassianEnabled: true, jiraProjects: [], prefetchMax: 5 },
      { jira_get: jiraGet, confluence_get: vi.fn() },
    );
    expect(result.prefetchItems).toHaveLength(2);
    // trace step for PROJ-1 must be ok=false
    const traceResults = result.prefetchTraceSteps.filter((s) => s.kind === "tool_result");
    const errStep = traceResults.find((s) => (s as { ok: boolean }).ok === false);
    expect(errStep).toBeDefined();
    // block still includes the success item
    expect(result.referencedBlock).toContain("### Jira: PROJ-2");
  });

  it("(d) trace steps reflect the REAL fetch results (two steps per ref)", async () => {
    const jiraGet = vi.fn().mockResolvedValue({ title: "MyIssue", status: "In Progress" });
    const result = await runPrefetch(
      "PROJ-42 is the ticket.",
      "",
      { atlassianEnabled: true, jiraProjects: [], prefetchMax: 5 },
      { jira_get: jiraGet, confluence_get: vi.fn() },
    );
    // One ref → exactly two trace steps [tool_call, tool_result]
    expect(result.prefetchTraceSteps).toHaveLength(2);
    expect(result.prefetchTraceSteps[0]?.kind).toBe("tool_call");
    expect(result.prefetchTraceSteps[1]?.kind).toBe("tool_result");
    // tool_result text contains the fetched title
    const trStep = result.prefetchTraceSteps[1] as { ok: boolean; text: string };
    expect(trStep.ok).toBe(true);
    expect(trStep.text).toContain("MyIssue");
  });

  it("closures=undefined (no atlassian wired) returns empty without throwing", async () => {
    const result = await runPrefetch(
      "PROJ-1",
      "",
      { atlassianEnabled: true, jiraProjects: [], prefetchMax: 5 },
      undefined,
    );
    expect(result.referencedBlock).toBe("");
    expect(result.prefetchTraceSteps).toHaveLength(0);
  });

  it("respects prefetchMax cap", async () => {
    const jiraGet = vi.fn().mockResolvedValue({ title: "X" });
    const result = await runPrefetch(
      "PROJ-1 PROJ-2 PROJ-3 PROJ-4 PROJ-5 PROJ-6",
      "",
      { atlassianEnabled: true, jiraProjects: [], prefetchMax: 3 },
      { jira_get: jiraGet, confluence_get: vi.fn() },
    );
    expect(result.prefetchItems).toHaveLength(3);
    expect(jiraGet).toHaveBeenCalledTimes(3);
  });
});
