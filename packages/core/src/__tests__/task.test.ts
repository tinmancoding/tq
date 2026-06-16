import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../store.js";
import { ftsSearchTasks } from "../search/keyword.js";

function freshStore(): Store {
  return Store.open({ path: ":memory:" });
}

describe("TaskRepo", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("creates a task with labels and indexes it for search", async () => {
    const t = store.tasks.create({
      title: "Fix auth cookie bug",
      body: "session expires early",
      labels: [{ key: "project", value: "aibm" }],
    });
    expect(t.status).toBe("backlog");
    expect(t.labels).toEqual([{ key: "project", value: "aibm" }]);

    const res = ftsSearchTasks(store.db, store.tasks, "auth cookie");
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.task.id).toBe(t.id);
    expect(res.vector).toBe(false);
  });

  it("records a system activity entry on status change", () => {
    const t = store.tasks.create({ title: "x" });
    store.tasks.move(t.id, "doing");
    const acts = store.tasks.listActivity(t.id);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.entry_type).toBe("system");
    expect(acts[0]!.meta).toEqual({ from: "backlog", to: "doing" });
  });

  it("stamps status_changed_at on create and only when status actually changes", () => {
    const t = store.tasks.create({ title: "x" });
    expect(t.status_changed_at).toBe(t.created_at);

    // Re-ordering within the same status (rank only) must not reset the clock.
    const sameStatus = store.tasks.move(t.id, "backlog", "V")!;
    expect(sameStatus.status_changed_at).toBe(t.status_changed_at);

    // A real status change advances it.
    const moved = store.tasks.move(t.id, "doing")!;
    expect(moved.status_changed_at >= t.status_changed_at).toBe(true);
    expect(moved.status_changed_at).toBe(moved.updated_at);
  });

  it("resolves unambiguous id prefixes and rejects ambiguous ones", () => {
    const t = store.tasks.create({ title: "only one" });
    expect(store.tasks.resolveId(t.id.slice(0, 12))).toBe(t.id);
    expect(store.tasks.resolveId("ffffffff")).toBeNull();
  });

  it("soft-deletes to dropped and hard-deletes fully", () => {
    const a = store.tasks.create({ title: "soft" });
    store.tasks.remove(a.id);
    expect(store.tasks.get(a.id)!.status).toBe("dropped");

    const b = store.tasks.create({ title: "hard" });
    store.tasks.remove(b.id, true);
    expect(store.tasks.get(b.id)).toBeNull();
  });

  it("reindexes when labels change", async () => {
    const t = store.tasks.create({ title: "searchable" });
    expect((ftsSearchTasks(store.db, store.tasks, "frontend")).hits).toHaveLength(0);
    store.tasks.addLabel(t.id, { key: "area", value: "frontend" });
    expect((ftsSearchTasks(store.db, store.tasks, "frontend")).hits).toHaveLength(1);
  });
});

describe("EventBus integration", () => {
  it("emits task.created on create", () => {
    const store = freshStore();
    const events: string[] = [];
    store.bus.subscribe((e) => events.push(e.event));
    store.tasks.create({ title: "watch me" });
    expect(events).toContain("task.created");
  });
});
