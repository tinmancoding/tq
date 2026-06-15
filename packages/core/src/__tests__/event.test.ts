import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../store.js";

function freshStore(): Store {
  return Store.open({ path: ":memory:" });
}

/** All events for an entity, oldest first (per-entity stream order). */
function streamOf(store: Store, scopeType: "task" | "intake", scopeId: string) {
  return store.events.forScope(scopeType, scopeId);
}

describe("EventStore (Phase B spine)", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("appends TaskCreated with the full payload and stream_seq 1", () => {
    const t = store.tasks.create({
      title: "Fix auth",
      body: "details",
      labels: [{ key: "project", value: "aibm" }],
      created_by: "human:laci",
    });
    const evs = streamOf(store, "task", t.id);
    expect(evs).toHaveLength(1);
    const e = evs[0]!;
    expect(e.type).toBe("TaskCreated");
    expect(e.scope_type).toBe("task");
    expect(e.stream_seq).toBe(1);
    expect(e.actor).toBe("human:laci");
    expect((e.payload as { title: string }).title).toBe("Fix auth");
    expect((e.payload as { labels: unknown[] }).labels).toEqual([
      { key: "project", value: "aibm" },
    ]);
  });

  it("records TaskUpdated/TaskMoved/Label/Ref/WorkLogged with contiguous per-entity stream_seq", () => {
    const t = store.tasks.create({ title: "T" });
    store.tasks.update(t.id, { priority: "high" });
    store.tasks.move(t.id, "doing");
    store.tasks.addLabel(t.id, { key: "area", value: "api" });
    store.tasks.removeLabel(t.id, { key: "area", value: "api" });
    store.tasks.addRef(t.id, { kind: "url", url: "https://x", external_id: null, title: null, meta: null });
    store.tasks.addActivity(t.id, { entry_type: "worklog", actor: "agent:pi", body: "pushed" });
    store.tasks.addActivity(t.id, { entry_type: "comment", actor: "human:laci", body: "note" });

    const types = streamOf(store, "task", t.id).map((e) => e.type);
    expect(types).toEqual([
      "TaskCreated",
      "TaskUpdated",
      "TaskMoved",
      "LabelAdded",
      "LabelRemoved",
      "RefAdded",
      "WorkLogged",
      "CommentAdded",
    ]);
    // contiguous 1..N for committed history
    const seqs = streamOf(store, "task", t.id).map((e) => e.stream_seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const moved = streamOf(store, "task", t.id).find((e) => e.type === "TaskMoved")!;
    expect(moved.payload).toMatchObject({ from: "backlog", to: "doing" });
    const updated = streamOf(store, "task", t.id).find((e) => e.type === "TaskUpdated")!;
    expect(updated.payload).toMatchObject({ changed: { priority: "high" } });
  });

  it("global seq strictly increases across entities and orders multi-entity writes", () => {
    const a = store.tasks.create({ title: "A" });
    const b = store.tasks.create({ title: "B" });
    store.tasks.move(a.id, "next");

    const all = store.events.read();
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length); // unique
    // per-entity stream_seq is independent
    expect(streamOf(store, "task", a.id).map((e) => e.stream_seq)).toEqual([1, 2]);
    expect(streamOf(store, "task", b.id).map((e) => e.stream_seq)).toEqual([1]);
  });

  it("captures intake lifecycle: IntakeCaptured then IntakeStatusChanged on discard", () => {
    const { intake } = store.intake.create({ body: "look at this", source: "manual" });
    store.intake.discard(intake.id, "noise");
    const evs = streamOf(store, "intake", intake.id);
    expect(evs.map((e) => e.type)).toEqual(["IntakeCaptured", "IntakeStatusChanged"]);
    expect(evs[1]!.payload).toMatchObject({ from: "new", to: "discarded", reason: "noise" });
  });

  it("promote emits TaskCreated + IntakePromoted + IntakeStatusChanged atomically (consecutive global seq)", () => {
    const { intake } = store.intake.create({ body: "promote me" });
    const before = store.events.maxSeq();
    const res = store.intake.promote(intake.id, { title: "Promoted task" });
    const after = store.events.read({ since: before });

    expect(after.map((e) => e.type)).toEqual([
      "TaskCreated",
      "IntakePromoted",
      "IntakeStatusChanged",
    ]);
    // consecutive global seq (one transaction)
    const seqs = after.map((e) => e.seq);
    expect(seqs[1]).toBe(seqs[0]! + 1);
    expect(seqs[2]).toBe(seqs[1]! + 1);
    expect((after[1]!.payload as { task_id: string }).task_id).toBe(res!.taskId);
    expect(after[2]!.payload).toMatchObject({ to: "promoted" });
  });

  it("read() filters by type and since; maxSeq tracks the head", () => {
    const t = store.tasks.create({ title: "T" });
    store.tasks.move(t.id, "doing");
    expect(store.events.maxSeq()).toBe(store.events.read().at(-1)!.seq);

    const onlyMoves = store.events.read({ types: ["TaskMoved"] });
    expect(onlyMoves).toHaveLength(1);
    expect(onlyMoves[0]!.type).toBe("TaskMoved");

    const head = store.events.maxSeq();
    store.tasks.move(t.id, "done");
    expect(store.events.read({ since: head }).map((e) => e.type)).toEqual(["TaskMoved"]);
  });
});
