import type { Store } from "../store.js";

export interface BackfillResult {
  tasks: number;
  intakes: number;
  activities: number;
  alreadyDone: boolean;
}

const FLAG = "backfill_events_v1";

/**
 * One-time backfill for a DB that predates the event log (Phase B/0007): for
 * every entity that has no events yet, synthesize a *genesis* snapshot
 * (`TaskCreated` / `IntakeCaptured` reflecting current columns) so that
 * `fold(log) == state` holds and consumers can replay-from-0. Also migrates the
 * legacy `intake.triage` JSON into `context.triage` (the column is dropped in
 * Phase G). Idempotent: guarded by a `schema_meta` flag and a per-entity
 * "has events?" check, so re-running (or running after live usage) is safe.
 *
 * Run with the daemon stopped. See scripts/backfill-events.ts.
 */
export function backfillEvents(store: Store): BackfillResult {
  const db = store.db;
  const done = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(FLAG);
  if (done) return { tasks: 0, intakes: 0, activities: 0, alreadyDone: true };

  const hasTaskEv = db.prepare(
    `SELECT 1 FROM event WHERE scope_type = 'task' AND scope_id = ? LIMIT 1`,
  );
  const hasIntakeEv = db.prepare(
    `SELECT 1 FROM event WHERE scope_type = 'intake' AND scope_id = ? LIMIT 1`,
  );

  let tasks = 0;
  let intakes = 0;
  let activities = 0;

  const taskRows = db.prepare(`SELECT * FROM task ORDER BY created_at`).all() as Record<
    string,
    unknown
  >[];
  for (const t of taskRows) {
    const id = t.id as string;
    if (hasTaskEv.get(id)) continue;
    const labels = db.prepare(`SELECT key, value FROM task_label WHERE task_id = ?`).all(id);
    const refs = (
      db
        .prepare(`SELECT kind, url, external_id, title, meta FROM task_ref WHERE task_id = ?`)
        .all(id) as Record<string, unknown>[]
    ).map((r) => ({
      kind: r.kind,
      url: r.url,
      external_id: r.external_id ?? null,
      title: r.title ?? null,
      meta: r.meta ? JSON.parse(r.meta as string) : null,
    }));
    db.transaction(() => {
      store.events.append({
        type: "TaskCreated",
        scopeType: "task",
        scopeId: id,
        actor: (t.created_by as string) ?? "human:laci",
        payload: {
          title: t.title,
          body: t.body ?? null,
          status: t.status,
          priority: t.priority ?? null,
          due_at: t.due_at ?? null,
          snooze_until: t.snooze_until ?? null,
          board_rank: t.board_rank ?? null,
          labels,
          refs,
          created_by: t.created_by ?? "human:laci",
        },
      });
      const acts = db
        .prepare(
          `SELECT * FROM activity WHERE task_id = ? AND entry_type IN ('worklog','comment') ORDER BY created_at`,
        )
        .all(id) as Record<string, unknown>[];
      for (const a of acts) {
        if (a.entry_type === "worklog") {
          store.events.append({
            type: "WorkLogged",
            scopeType: "task",
            scopeId: id,
            actor: a.actor as string,
            payload: {
              description: a.body,
              additionalContext: a.meta ? JSON.parse(a.meta as string) : undefined,
            },
          });
        } else {
          store.events.append({
            type: "CommentAdded",
            scopeType: "task",
            scopeId: id,
            actor: a.actor as string,
            payload: { body: a.body },
          });
        }
        activities++;
      }
      for (const [ns, val] of Object.entries(parseJson(t.context))) {
        store.events.append({
          type: "ContextUpdated",
          scopeType: "task",
          scopeId: id,
          actor: "system:backfill",
          payload: { namespace: ns, value: val },
        });
      }
    })();
    tasks++;
  }

  const intakeRows = db.prepare(`SELECT * FROM intake ORDER BY created_at`).all() as Record<
    string,
    unknown
  >[];
  for (const i of intakeRows) {
    const id = i.id as string;
    if (hasIntakeEv.get(id)) continue;
    const triage = i.triage ? JSON.parse(i.triage as string) : null;
    const existingCtx = parseJson(i.context);
    db.transaction(() => {
      store.events.append({
        type: "IntakeCaptured",
        scopeType: "intake",
        scopeId: id,
        actor: "human:laci",
        payload: {
          source: i.source,
          source_ref: i.source_ref ?? null,
          event_sig: i.event_sig ?? null,
          body: i.body ?? null,
          action_verbs: i.action_verbs ? JSON.parse(i.action_verbs as string) : null,
          labels: i.labels ? JSON.parse(i.labels as string) : null,
          watchlist_id: i.watchlist_id ?? null,
        },
      });
      if (i.status && i.status !== "new") {
        store.events.append({
          type: "IntakeStatusChanged",
          scopeType: "intake",
          scopeId: id,
          actor: "system:backfill",
          payload: { from: "new", to: i.status, reason: i.discard_reason ?? undefined },
        });
      }
      // migrate legacy triage column → context.triage (folds + appends ContextUpdated)
      if (triage) store.context.set("intake", id, "triage", triage, "agent:triage");
      for (const [ns, val] of Object.entries(existingCtx)) {
        if (ns === "triage" && triage) continue;
        store.events.append({
          type: "ContextUpdated",
          scopeType: "intake",
          scopeId: id,
          actor: "system:backfill",
          payload: { namespace: ns, value: val },
        });
      }
    })();
    intakes++;
  }

  db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`).run(
    FLAG,
    new Date().toISOString(),
  );
  return { tasks, intakes, activities, alreadyDone: false };
}

function parseJson(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "string") return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
