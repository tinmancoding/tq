// ─────────────────────────────── Enums ────────────────────────────────
export const INTAKE_STATUSES = ["new", "triaged", "promoted", "discarded"] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const TASK_STATUSES = [
  "backlog",
  "next",
  "doing",
  "blocked",
  "done",
  "dropped",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["high", "med", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ENTRY_TYPES = ["worklog", "comment", "system"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const DISCARD_REASONS = ["noise", "duplicate", "irrelevant", "merged"] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

// ─────────────────────────────── Entities ─────────────────────────────
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
  status_changed_at: string;
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

/**
 * One step in the recorded triage session transcript — lets the dashboard show
 * what the LLM actually did (its reasoning text, the searches it ran, the
 * results it saw, and any error that aborted the pass).
 */
export type TriageTraceStep =
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; tool: string; args: unknown }
  | { kind: "tool_result"; tool: string; ok: boolean; text: string }
  | { kind: "error"; text: string };

export interface Intake {
  id: string;
  status: IntakeStatus;
  source: string;
  source_ref: string | null;
  event_sig: string | null;
  body: string | null;
  action_verbs: string[] | null;
  discard_reason: string | null;
  triage: unknown | null;
  triage_error: string | null;
  triage_trace: TriageTraceStep[] | null;
  labels: Record<string, string> | null;
  watchlist_id: string | null;
  created_at: string;
  triaged_at: string | null;
}

// ─────────────────────────────── Triage ───────────────────────────────
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

// ─────────────────────────────── Workspaces ───────────────────────────
export const WORKSPACE_PROVIDERS = ["tasktree", "local"] as const;
export type WorkspaceProviderName = (typeof WORKSPACE_PROVIDERS)[number];

export const WORKSPACE_STATUSES = [
  "provisioning",
  "ready",
  "error",
  "detached",
] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export interface Workspace {
  id: string;
  task_id: string | null;
  provider: string;
  root_path: string;
  name: string;
  status: WorkspaceStatus;
  error: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  last_seen_at: string | null;
}

// ─────────────────────────────── Agent sessions ───────────────────────
export const SESSION_STATUSES = ["seen", "active", "ended"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface AgentSession {
  id: string;
  task_id: string | null;
  workspace_id: string | null;
  session_file: string;
  cwd: string;
  title: string | null;
  model: string | null;
  message_count: number;
  started_at: string | null;
  last_activity_at: string | null;
  status: SessionStatus;
  file_present: boolean;
  created_at: string;
}

// ─────────────────────────────── Actors ───────────────────────────────
export const DEFAULT_ACTOR = "human:laci";
