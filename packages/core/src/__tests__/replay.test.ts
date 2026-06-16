import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { replay, type ReplayRef } from "../projection/reduce.js";

function freshStore(): Store {
  return Store.open({
    path: ":memory:",
    attachmentsDir: mkdtempSync(join(tmpdir(), "tq-replay-")),
  });
}

/** Normalize a live task row to the reducer's comparable shape. */
function liveTask(store: Store, id: string) {
  const t = store.tasks.get(id)!;
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status,
    priority: t.priority,
    due_at: t.due_at,
    snooze_until: t.snooze_until,
    board_rank: t.board_rank,
    created_by: t.created_by,
    labels: t.labels.map((l) => `${l.key}\u0000${l.value}`).sort(),
    refs: t.refs
      .map((r): ReplayRef => ({ kind: r.kind, url: r.url, external_id: r.external_id, title: r.title }))
      .sort((a, b) => `${a.kind}\u0000${a.url}`.localeCompare(`${b.kind}\u0000${b.url}`)),
    context: t.context,
  };
}

function liveIntake(store: Store, id: string) {
  const i = store.intake.get(id)!;
  return {
    id: i.id,
    status: i.status,
    source: i.source,
    source_ref: i.source_ref,
    event_sig: i.event_sig,
    body: i.body,
    action_verbs: i.action_verbs,
    labels: i.labels,
    watchlist_id: i.watchlist_id,
    discard_reason: i.discard_reason,
    context: i.context,
  };
}

describe("fold(log) == state (Q10 invariant)", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("reconstructs task + intake core state from the event log alone", () => {
    // Exercise a wide spread of mutations.
    const a = store.tasks.create({
      title: "Auth bug",
      body: "session expires",
      priority: "high",
      labels: [{ key: "project", value: "tq" }],
      refs: [{ kind: "url", url: "https://x", external_id: null, title: null, meta: null }],
      created_by: "human:laci",
    });
    store.tasks.update(a.id, { title: "Auth bug (urgent)", priority: "med" });
    store.tasks.move(a.id, "doing", "rank-5");
    store.tasks.addLabel(a.id, { key: "area", value: "api" });
    store.tasks.addLabel(a.id, { key: "tmp", value: "x" });
    store.tasks.removeLabel(a.id, { key: "tmp", value: "x" });
    store.tasks.addRef(a.id, { kind: "github_pr", url: "https://gh/1", external_id: "1", title: "PR", meta: null });
    store.context.set("task", a.id, "triage", { summary: "real bug" }, "agent:triage");
    store.context.set("task", a.id, "search", { score: 0.9 }, "agent:search");

    const b = store.tasks.create({ title: "Second", labels: [] });
    store.tasks.move(b.id, "done");

    // A task that gets hard-deleted should vanish from the fold too.
    const gone = store.tasks.create({ title: "ephemeral" });
    store.tasks.remove(gone.id, true);

    // Intake lifecycle incl. promote (multi-event) and discard.
    const { intake: cap } = store.intake.create({ body: "promote me", source: "manual", labels: { src: "cli" } });
    store.intake.promote(cap.id, { title: "Promoted" });
    const { intake: noise } = store.intake.create({ body: "spam" });
    store.intake.discard(noise.id, "noise");
    store.context.set("intake", noise.id, "triage", { category: "noise" }, "agent:triage");

    // Fold the entire log.
    const reduced = replay(store.events.read({ limit: 100000 }));

    // Tasks: every live task matches its folded projection; deleted one is absent.
    const liveTaskIds = store.tasks.list({ limit: 1000 }).map((t) => t.id);
    expect(reduced.tasks.has(gone.id)).toBe(false);
    expect(new Set(reduced.tasks.keys())).toEqual(new Set(liveTaskIds));
    for (const id of liveTaskIds) {
      expect(reduced.tasks.get(id)).toEqual(liveTask(store, id));
    }

    // Intakes: compare folded vs live for the event-captured columns.
    for (const id of [cap.id, noise.id]) {
      expect(reduced.intake.get(id)).toEqual(liveIntake(store, id));
    }
    // promote flipped status to 'promoted'; discard to 'discarded'
    expect(reduced.intake.get(cap.id)!.status).toBe("promoted");
    expect(reduced.intake.get(noise.id)!.status).toBe("discarded");
    expect(reduced.intake.get(noise.id)!.discard_reason).toBe("noise");
    expect(reduced.intake.get(noise.id)!.context).toEqual({ triage: { category: "noise" } });
  });

  it("reflects a spilled context $ref identically in the fold", () => {
    store = Store.open({
      path: ":memory:",
      attachmentsDir: mkdtempSync(join(tmpdir(), "tq-replay-")),
      contextSpillBytes: 32,
    });
    const t = store.tasks.create({ title: "T" });
    store.context.set("task", t.id, "triage", { big: "y".repeat(200) }, "agent:triage");

    const reduced = replay(store.events.read({ limit: 1000 }));
    expect(reduced.tasks.get(t.id)!.context).toEqual(store.tasks.get(t.id)!.context);
    // and it really is a $ref, not inline
    expect((store.tasks.get(t.id)!.context.triage as { $ref?: string }).$ref).toBeTruthy();
  });
});
