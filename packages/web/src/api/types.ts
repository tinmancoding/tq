// Hand-written API types mirroring @tq/core domain (kept browser-pure so we
// don't pull core's native/node deps into the web bundle). Backfill with
// OpenAPI codegen later (design §17) if the surface grows.

export type IntakeStatus = "new" | "triaged" | "promoted" | "discarded";
export type TaskStatus =
  | "backlog"
  | "next"
  | "doing"
  | "blocked"
  | "done"
  | "dropped";
export type Priority = "high" | "med" | "low";
export type EntryType = "worklog" | "comment" | "system";
export type DiscardReason = "noise" | "duplicate" | "irrelevant" | "merged";

export const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "next",
  "doing",
  "blocked",
  "done",
  "dropped",
];

export interface Label {
  key: string;
  value: string;
}

export interface TaskRef {
  id: string;
  task_id: string;
  kind: string;
  url: string;
  external_id: string | null;
  title: string | null;
  meta: unknown | null;
}

export interface Task {
  id: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: Priority | null;
  due_at: string | null;
  snooze_until: string | null;
  board_rank: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  labels: Label[];
  refs: TaskRef[];
}

export interface Activity {
  id: string;
  task_id: string;
  entry_type: EntryType;
  actor: string;
  body: string;
  meta: unknown | null;
  created_at: string;
}

export interface TriageResult {
  summary: string;
  category: string;
  suggested_title: string;
  suggested_body?: string;
  suggested_labels: Label[];
  suggested_action_verbs: string[];
  suggested_priority?: Priority;
  refs: { kind: string; url: string; external_id?: string; title?: string }[];
  duplicate: {
    decision: "none" | "weak" | "strong";
    task_id?: string;
    reason?: string;
  };
  actionable_confidence: number;
  task_count_suggestion: number;
}

export interface Intake {
  id: string;
  status: IntakeStatus;
  source: string;
  source_ref: string | null;
  event_sig: string | null;
  body: string | null;
  action_verbs: string[] | null;
  discard_reason: string | null;
  triage: TriageResult | null;
  triage_error: string | null;
  labels: Record<string, string> | null;
  watchlist_id: string | null;
  created_at: string;
  triaged_at: string | null;
}

export interface AttachmentMeta {
  sha256: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  filename: string | null;
  ord: number;
}

export interface IntakeDetail extends Intake {
  linked_task_ids: string[];
  attachments: AttachmentMeta[];
}

export interface JobCounts {
  queued: number;
  running: number;
  done: number;
  error: number;
}

export interface HealthSnapshot {
  ok: boolean;
  version: string;
  uptime_sec: number;
  jobs: JobCounts;
  counts: { tasks: number; intake: number };
  aws: { configured: boolean; reachable: boolean | null };
  db_path: string;
}
