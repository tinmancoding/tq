import type { TriageResult } from "../domain/types.js";

/**
 * The action the gate decides to take after triage. The worker executes it.
 * See design §5 "Gate decision matrix".
 */
export type GateAction =
  | { kind: "auto_link"; task_id: string; reason?: string }
  | { kind: "auto_create" }
  | { kind: "review"; reason: string };

/**
 * Pure decision function. Conservative by design:
 *  - multiple suggested tasks → always manual review (never auto fan-out)
 *  - strong duplicate w/ candidate → auto-link to it
 *  - strong duplicate w/o candidate id → review (can't link safely)
 *  - weak duplicate → review
 *  - no duplicate & confidence ≥ threshold → auto-create
 *  - otherwise → review
 */
export function decideGate(triage: TriageResult, autoCreateConfidence: number): GateAction {
  if (triage.task_count_suggestion > 1) {
    return { kind: "review", reason: "multiple tasks suggested" };
  }

  const dup = triage.duplicate;
  if (dup.decision === "strong") {
    if (dup.task_id) {
      return { kind: "auto_link", task_id: dup.task_id, reason: dup.reason };
    }
    return { kind: "review", reason: "strong duplicate without candidate id" };
  }

  if (dup.decision === "weak") {
    return { kind: "review", reason: "weak duplicate — needs verification" };
  }

  // decision === "none"
  if (triage.actionable_confidence >= autoCreateConfidence) {
    return { kind: "auto_create" };
  }
  return {
    kind: "review",
    reason: `low actionable confidence (${triage.actionable_confidence.toFixed(2)} < ${autoCreateConfidence})`,
  };
}
