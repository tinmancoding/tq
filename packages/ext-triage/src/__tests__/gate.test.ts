import { describe, it, expect } from "vitest";
import { decideGate } from "../gate.js";
import type { TriageResult } from "@tq/contract";

function base(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    summary: "s",
    category: "bug",
    suggested_title: "t",
    suggested_labels: [],
    suggested_action_verbs: [],
    refs: [],
    duplicate: { decision: "none" },
    actionable_confidence: 0.9,
    task_count_suggestion: 1,
    ...overrides,
  };
}

describe("decideGate", () => {
  const threshold = 0.8;

  it("auto-creates when no duplicate and confidence ≥ threshold", () => {
    expect(decideGate(base({ actionable_confidence: 0.85 }), threshold)).toEqual({
      kind: "auto_create",
    });
  });

  it("reviews when no duplicate but confidence < threshold", () => {
    const a = decideGate(base({ actionable_confidence: 0.5 }), threshold);
    expect(a.kind).toBe("review");
  });

  it("auto-links on strong duplicate with a candidate id", () => {
    const a = decideGate(
      base({ duplicate: { decision: "strong", task_id: "t1", reason: "same" } }),
      threshold,
    );
    expect(a).toEqual({ kind: "auto_link", task_id: "t1", reason: "same" });
  });

  it("reviews a strong duplicate that lacks a candidate id", () => {
    const a = decideGate(base({ duplicate: { decision: "strong" } }), threshold);
    expect(a.kind).toBe("review");
  });

  it("reviews weak duplicates regardless of confidence", () => {
    const a = decideGate(
      base({ duplicate: { decision: "weak" }, actionable_confidence: 0.99 }),
      threshold,
    );
    expect(a.kind).toBe("review");
  });

  it("always reviews when multiple tasks are suggested", () => {
    const a = decideGate(base({ task_count_suggestion: 3 }), threshold);
    expect(a.kind).toBe("review");
  });
});
