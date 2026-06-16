import { Type, type Static } from "@sinclair/typebox";

/**
 * The public TQ API contract — the single source of truth for wire shapes,
 * shared by the daemon (request validation), the web + CLI clients, and the
 * extension SDK's injected CoreClient. Browser-pure: depends only on TypeBox,
 * never on @tq/core's native/node modules.
 *
 * Types are *derived* from the TypeBox schemas via `Static<>`, so there is no
 * codegen step to run and nothing to go stale — `tsc` is the staleness gate.
 */

// ───────────────────────────── enums ─────────────────────────────
export const TASK_STATUSES = ["backlog", "next", "doing", "blocked", "done", "dropped"] as const;
export const PRIORITIES = ["high", "med", "low"] as const;
export const INTAKE_STATUSES = ["new", "triaged", "promoted", "discarded"] as const;
export const ENTRY_TYPES = ["worklog", "comment", "system"] as const;
export const DISCARD_REASONS = ["noise", "duplicate", "irrelevant", "merged"] as const;

export const TaskStatusSchema = Type.Union(TASK_STATUSES.map((s) => Type.Literal(s)));
export const PrioritySchema = Type.Union(PRIORITIES.map((p) => Type.Literal(p)));
export const IntakeStatusSchema = Type.Union(INTAKE_STATUSES.map((s) => Type.Literal(s)));
export const EntryTypeSchema = Type.Union(ENTRY_TYPES.map((s) => Type.Literal(s)));

export type TaskStatus = Static<typeof TaskStatusSchema>;
export type Priority = Static<typeof PrioritySchema>;
export type IntakeStatus = Static<typeof IntakeStatusSchema>;
export type EntryType = Static<typeof EntryTypeSchema>;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

// ───────────────────────────── entities ─────────────────────────────
export const LabelSchema = Type.Object({ key: Type.String(), value: Type.String() });
export type Label = Static<typeof LabelSchema>;

export const TaskRefSchema = Type.Object({
  id: Type.String(),
  task_id: Type.String(),
  kind: Type.String(),
  url: Type.String(),
  external_id: Nullable(Type.String()),
  title: Nullable(Type.String()),
  meta: Type.Union([Type.Unknown(), Type.Null()]),
});
export type TaskRef = Static<typeof TaskRefSchema>;

export const TaskSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  body: Nullable(Type.String()),
  status: TaskStatusSchema,
  priority: Type.Union([PrioritySchema, Type.Null()]),
  due_at: Nullable(Type.String()),
  snooze_until: Nullable(Type.String()),
  board_rank: Nullable(Type.String()),
  created_by: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
  done_at: Nullable(Type.String()),
  status_changed_at: Type.String(),
  labels: Type.Array(LabelSchema),
  refs: Type.Array(TaskRefSchema),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type Task = Static<typeof TaskSchema>;

export const ActivitySchema = Type.Object({
  id: Type.String(),
  task_id: Type.String(),
  entry_type: EntryTypeSchema,
  actor: Type.String(),
  body: Type.String(),
  meta: Type.Union([Type.Unknown(), Type.Null()]),
  created_at: Type.String(),
});
export type Activity = Static<typeof ActivitySchema>;

export const TriageResultSchema = Type.Object({
  summary: Type.String(),
  category: Type.String(),
  suggested_title: Type.String(),
  suggested_body: Type.Optional(Type.String()),
  suggested_labels: Type.Array(LabelSchema),
  suggested_action_verbs: Type.Array(Type.String()),
  suggested_priority: Type.Optional(PrioritySchema),
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
    task_id: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  }),
  actionable_confidence: Type.Number(),
  task_count_suggestion: Type.Number(),
});
export type TriageResult = Static<typeof TriageResultSchema>;

export type TriageTraceStep =
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; tool: string; args: unknown }
  | { kind: "tool_result"; tool: string; ok: boolean; text: string }
  | { kind: "error"; text: string };

export const IntakeSchema = Type.Object({
  id: Type.String(),
  status: IntakeStatusSchema,
  source: Type.String(),
  source_ref: Nullable(Type.String()),
  event_sig: Nullable(Type.String()),
  body: Nullable(Type.String()),
  action_verbs: Type.Union([Type.Array(Type.String()), Type.Null()]),
  discard_reason: Nullable(Type.String()),
  triage: Type.Union([TriageResultSchema, Type.Null()]),
  triage_error: Nullable(Type.String()),
  labels: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
  watchlist_id: Nullable(Type.String()),
  created_at: Type.String(),
  triaged_at: Nullable(Type.String()),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type Intake = Static<typeof IntakeSchema>;

export const AttachmentMetaSchema = Type.Object({
  sha256: Type.String(),
  mime: Type.String(),
  bytes: Type.Number(),
  width: Type.Union([Type.Number(), Type.Null()]),
  height: Type.Union([Type.Number(), Type.Null()]),
  filename: Nullable(Type.String()),
  ord: Type.Number(),
});
export type AttachmentMeta = Static<typeof AttachmentMetaSchema>;

export interface IntakeDetail extends Intake {
  linked_task_ids: string[];
  attachments: AttachmentMeta[];
}

export interface LinkedIntake {
  id: string;
  relation: string;
  summary: string | null;
}

export interface TaskDetail extends Task {
  activity: Activity[];
  linked_intakes: LinkedIntake[];
}

export interface SubscriptionHealth {
  consumer_id: string;
  cursor: number;
  lag: number;
  dead_letters: number;
  last_seen_at: string | null;
}

export interface HealthSnapshot {
  ok: boolean;
  version: string;
  uptime_sec: number;
  counts: { tasks: number; intake: number };
  seq?: number;
  subscriptions?: SubscriptionHealth[];
  aws: { configured: boolean; reachable: boolean | null };
  db_path: string;
}

// ───────────────────────────── requests ─────────────────────────────
export const CreateTaskBody = Type.Object({
  title: Type.String({ minLength: 1 }),
  body: Type.Optional(Type.String()),
  status: Type.Optional(TaskStatusSchema),
  priority: Type.Optional(PrioritySchema),
  due_at: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Array(LabelSchema)),
});
export type CreateTaskInput = Static<typeof CreateTaskBody>;

export const UpdateTaskBody = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1 })),
  body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  priority: Type.Optional(Type.Union([PrioritySchema, Type.Null()])),
  due_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  snooze_until: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type UpdateTaskInput = Static<typeof UpdateTaskBody>;

export const MoveTaskBody = Type.Object({
  status: TaskStatusSchema,
  board_rank: Type.Optional(Type.String()),
});
export type MoveTaskInput = Static<typeof MoveTaskBody>;

export const AddRefBody = Type.Object({
  kind: Type.String(),
  url: Type.String(),
  external_id: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  meta: Type.Optional(Type.Unknown()),
});
export type AddRefInput = Static<typeof AddRefBody>;

export const AddActivityBody = Type.Object({
  entry_type: Type.Union([Type.Literal("worklog"), Type.Literal("comment")]),
  body: Type.String({ minLength: 1 }),
});
export type AddActivityInput = Static<typeof AddActivityBody>;

export const ListTasksQuery = Type.Object({
  status: Type.Optional(TaskStatusSchema),
  label: Type.Optional(Type.String()),
  group: Type.Optional(Type.Literal("status")),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const PromoteIntakeBody = Type.Object({
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: Type.Optional(TaskStatusSchema),
  labels: Type.Optional(Type.Array(LabelSchema)),
});
export type PromoteIntakeInput = Static<typeof PromoteIntakeBody>;

export const SetContextResponse = Type.Object({
  context: Type.Record(Type.String(), Type.Unknown()),
  spilled: Type.Boolean(),
});
export type SetContextResult = Static<typeof SetContextResponse>;

// ───────────────────────────── search ─────────────────────────────
export interface SearchHit {
  task: Task;
  score: number;
  signals?: { fts: boolean; vector: boolean };
}
export interface SearchResult {
  hits: SearchHit[];
  vector?: boolean;
}
