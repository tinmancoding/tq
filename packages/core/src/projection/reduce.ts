import type { EventRow } from "../domain/event.js";

/**
 * Pure projection: fold the event log back into current core state. This is the
 * shared reducer behind the Q10 `fold(log) == state` invariant (and, later,
 * extension read-model rebuilds). It reconstructs exactly the state that the
 * event catalog fully captures — entity columns, labels, refs, and context.
 *
 * Deliberately NOT reconstructed (excluded from the equivalence check):
 *   - volatile/derived timestamps (created_at, updated_at, done_at, …)
 *   - the migrating `intake.triage*` columns (move to context in Phase G)
 *   - the `activity` timeline (worklog/comment are event-sourced; full
 *     activity-as-projection is a follow-up — see Phase C notes)
 */

export interface ReplayTask {
  id: string;
  title: string;
  body: string | null;
  status: string;
  priority: string | null;
  due_at: string | null;
  snooze_until: string | null;
  board_rank: string | null;
  created_by: string;
  labels: string[]; // normalized "key\u0000value", sorted
  refs: ReplayRef[]; // normalized + sorted
  context: Record<string, unknown>;
}

export interface ReplayRef {
  kind: string;
  url: string;
  external_id: string | null;
  title: string | null;
}

export interface ReplayIntake {
  id: string;
  status: string;
  source: string;
  source_ref: string | null;
  event_sig: string | null;
  body: string | null;
  action_verbs: string[] | null;
  labels: Record<string, string> | null;
  watchlist_id: string | null;
  discard_reason: string | null;
  context: Record<string, unknown>;
}

export interface ReplayState {
  tasks: Map<string, ReplayTask>;
  intake: Map<string, ReplayIntake>;
}

type Json = Record<string, unknown>;

export function replay(events: EventRow[]): ReplayState {
  const tasks = new Map<string, ReplayTask>();
  const labelSets = new Map<string, Set<string>>();
  const intake = new Map<string, ReplayIntake>();

  const labelKey = (key: string, value: string) => `${key}\u0000${value}`;

  for (const e of events) {
    const p = (e.payload ?? {}) as Json;
    switch (e.type) {
      case "TaskCreated": {
        const id = e.scope_id!;
        const labels = new Set<string>(
          ((p.labels as { key: string; value: string }[]) ?? []).map((l) => labelKey(l.key, l.value)),
        );
        labelSets.set(id, labels);
        tasks.set(id, {
          id,
          title: p.title as string,
          body: (p.body as string | null) ?? null,
          status: (p.status as string) ?? "backlog",
          priority: (p.priority as string | null) ?? null,
          due_at: (p.due_at as string | null) ?? null,
          snooze_until: (p.snooze_until as string | null) ?? null,
          board_rank: (p.board_rank as string | null) ?? null,
          created_by: p.created_by as string,
          labels: [],
          refs: ((p.refs as ReplayRef[]) ?? []).map(normRef),
          context: {},
        });
        break;
      }
      case "TaskUpdated": {
        const t = tasks.get(e.scope_id!);
        if (!t) break;
        const changed = (p.changed as Json) ?? {};
        for (const [k, v] of Object.entries(changed)) (t as unknown as Json)[k] = v;
        break;
      }
      case "TaskMoved": {
        const t = tasks.get(e.scope_id!);
        if (!t) break;
        t.status = p.to as string;
        if (p.board_rank != null) t.board_rank = p.board_rank as string; // mirrors COALESCE
        break;
      }
      case "TaskDeleted": {
        tasks.delete(e.scope_id!);
        labelSets.delete(e.scope_id!);
        break;
      }
      case "LabelAdded": {
        labelSets.get(e.scope_id!)?.add(labelKey(p.key as string, p.value as string));
        break;
      }
      case "LabelRemoved": {
        labelSets.get(e.scope_id!)?.delete(labelKey(p.key as string, p.value as string));
        break;
      }
      case "RefAdded": {
        tasks.get(e.scope_id!)?.refs.push(normRef(p as unknown as ReplayRef));
        break;
      }
      case "IntakeCaptured": {
        const id = e.scope_id!;
        intake.set(id, {
          id,
          status: "new",
          source: (p.source as string) ?? "manual",
          source_ref: (p.source_ref as string | null) ?? null,
          event_sig: (p.event_sig as string | null) ?? null,
          body: (p.body as string | null) ?? null,
          action_verbs: (p.action_verbs as string[] | null) ?? null,
          labels: (p.labels as Record<string, string> | null) ?? null,
          watchlist_id: (p.watchlist_id as string | null) ?? null,
          discard_reason: null,
          context: {},
        });
        break;
      }
      case "IntakeStatusChanged": {
        const i = intake.get(e.scope_id!);
        if (!i) break;
        i.status = p.to as string;
        if (p.to === "discarded") i.discard_reason = (p.reason as string | null) ?? null;
        break;
      }
      case "ContextUpdated": {
        const target =
          e.scope_type === "task" ? tasks.get(e.scope_id!) : intake.get(e.scope_id!);
        if (target) target.context[p.namespace as string] = p.value;
        break;
      }
      // IntakePromoted / IntakeLinked / WorkLogged / CommentAdded carry no
      // entity-column state (links + timeline are separate concerns).
      default:
        break;
    }
  }

  // Finalize normalized label arrays.
  for (const [id, t] of tasks) {
    t.labels = [...(labelSets.get(id) ?? [])].sort();
    t.refs = t.refs.slice().sort(refCmp);
  }
  return { tasks, intake };
}

function normRef(r: Partial<ReplayRef>): ReplayRef {
  return {
    kind: r.kind as string,
    url: r.url as string,
    external_id: (r.external_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
  };
}

function refCmp(a: ReplayRef, b: ReplayRef): number {
  return `${a.kind}\u0000${a.url}`.localeCompare(`${b.kind}\u0000${b.url}`);
}
