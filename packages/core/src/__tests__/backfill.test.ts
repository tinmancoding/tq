import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { backfillEvents } from "../projection/backfill.js";
import { replay } from "../projection/reduce.js";

function freshStore(): Store {
  return Store.open({
    path: ":memory:",
    attachmentsDir: mkdtempSync(join(tmpdir(), "tq-backfill-")),
  });
}

/** Insert a legacy task row directly, bypassing the repo (so no events exist). */
function legacyTask(store: Store, t: Record<string, unknown>): void {
  const ts = "2025-01-01T00:00:00.000Z";
  store.db
    .prepare(
      `INSERT INTO task (id, title, body, status, priority, due_at, snooze_until, board_rank,
         created_by, created_at, updated_at, done_at, status_changed_at, context)
       VALUES (@id, @title, @body, @status, @priority, NULL, NULL, @board_rank,
         @created_by, @ts, @ts, NULL, @ts, @context)`,
    )
    .run({
      id: t.id,
      title: t.title,
      body: t.body ?? null,
      status: t.status ?? "backlog",
      priority: t.priority ?? null,
      board_rank: t.board_rank ?? null,
      created_by: t.created_by ?? "human:laci",
      ts,
      context: t.context ?? "{}",
    });
}

describe("backfillEvents (Phase C)", () => {
  it("synthesizes genesis events so fold(log) == state for legacy rows", () => {
    const store = freshStore();

    // Legacy task with labels, a ref, and worklog activity — all pre-event-log.
    legacyTask(store, { id: "t1", title: "Legacy", body: "b", status: "doing", priority: "high" });
    store.db.prepare(`INSERT INTO task_label (task_id, key, value) VALUES (?, ?, ?)`).run("t1", "project", "tq");
    store.db
      .prepare(`INSERT INTO task_ref (id, task_id, kind, url, external_id, title, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("r1", "t1", "url", "https://x", null, null, null);
    store.db
      .prepare(
        `INSERT INTO activity (id, task_id, entry_type, actor, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("ac1", "t1", "worklog", "agent:pi", "did work", null, "2025-01-02T00:00:00.000Z");

    // Legacy intake whose triage result lives in the context bag (migration
    // 0010 moved it there from the dropped column before backfill runs).
    store.db
      .prepare(
        `INSERT INTO intake (id, status, source, source_ref, event_sig, body, action_verbs,
           discard_reason, labels, watchlist_id, created_at, triaged_at, context)
         VALUES (?, 'triaged', 'manual', NULL, NULL, 'look', NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        "i1",
        "2025-01-01T00:00:00.000Z",
        "2025-01-01T01:00:00.000Z",
        JSON.stringify({ triage: { summary: "a bug", category: "bug" } }),
      );

    const res = backfillEvents(store);
    expect(res.alreadyDone).toBe(false);
    expect(res.tasks).toBe(1);
    expect(res.intakes).toBe(1);
    expect(res.activities).toBe(1);

    // The triage result (already in context) is preserved.
    expect(store.context.get("intake", "i1")).toEqual({
      triage: { summary: "a bug", category: "bug" },
    });

    // fold(log) reproduces current state.
    const reduced = replay(store.events.read({ limit: 100000 }));
    const rt = reduced.tasks.get("t1")!;
    expect(rt.title).toBe("Legacy");
    expect(rt.status).toBe("doing");
    expect(rt.priority).toBe("high");
    expect(rt.labels).toEqual(["project\u0000tq"]);
    expect(rt.refs).toEqual([{ kind: "url", url: "https://x", external_id: null, title: null }]);

    const ri = reduced.intake.get("i1")!;
    expect(ri.status).toBe("triaged");
    expect(ri.context).toEqual({ triage: { summary: "a bug", category: "bug" } });

    // Worklog became a WorkLogged event.
    expect(store.events.read({ types: ["WorkLogged"] })).toHaveLength(1);
  });

  it("is idempotent: a second run is a no-op, and live-created rows are skipped", () => {
    const store = freshStore();
    legacyTask(store, { id: "t1", title: "Legacy" });
    // A row created via the repo already has events — must not be double-counted.
    const live = store.tasks.create({ title: "Live" });

    const first = backfillEvents(store);
    expect(first.tasks).toBe(1); // only the legacy one
    expect(store.events.read({ scopeType: "task", scopeId: live.id }).length).toBe(1); // unchanged

    const second = backfillEvents(store);
    expect(second.alreadyDone).toBe(true);
    expect(second.tasks).toBe(0);
  });
});
