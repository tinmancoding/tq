import { Type, type Static } from "@sinclair/typebox";

/**
 * Structured output schema for triage. The `emit_triage` tool uses this as its
 * parameter schema, so the LLM is forced to produce a well-formed result.
 */
export const TriageResultSchema = Type.Object({
  summary: Type.String({ description: "One-line human summary of the intake." }),
  category: Type.String({ description: "bug|chore|review|read|idea|… (freeform)." }),
  suggested_title: Type.String(),
  suggested_body: Type.Optional(
    Type.String({ description: "Enriched markdown body, including text extracted from images." }),
  ),
  suggested_labels: Type.Array(
    Type.Object({ key: Type.String(), value: Type.String() }),
  ),
  suggested_action_verbs: Type.Array(Type.String(), {
    description: "1-2 imperative verbs, e.g. review, fix, read.",
  }),
  suggested_priority: Type.Optional(
    Type.Union([Type.Literal("high"), Type.Literal("med"), Type.Literal("low")]),
  ),
  refs: Type.Array(
    Type.Object({
      kind: Type.String(),
      url: Type.String(),
      external_id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
    }),
  ),
  duplicate: Type.Object({
    decision: Type.Union([Type.Literal("none"), Type.Literal("weak"), Type.Literal("strong")]),
    task_id: Type.Optional(Type.String({ description: "Best candidate task id (from search_tasks)." })),
    reason: Type.Optional(Type.String()),
  }),
  actionable_confidence: Type.Number({
    minimum: 0,
    maximum: 1,
    description: "0..1 — is this a clear, well-defined, actionable task?",
  }),
  task_count_suggestion: Type.Integer({
    minimum: 0,
    description: "1 normally; >1 if the intake implies multiple distinct tasks.",
  }),
});

export type TriageResultStatic = Static<typeof TriageResultSchema>;
