import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../store.js";
import { WorkspaceConflictError } from "../domain/workspace.js";

function freshStore(): Store {
  return Store.open({ path: ":memory:" });
}

describe("WorkspaceRepo", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  function task() {
    return store.tasks.create({ title: "t" });
  }

  it("creates a workspace and enforces 1:1 per task", () => {
    const t = task();
    const ws = store.workspaces.create({
      task_id: t.id,
      provider: "local",
      root_path: "/tmp/ws-a",
      name: "ws-a",
    });
    expect(ws.status).toBe("ready");
    expect(store.workspaces.getByTask(t.id)!.id).toBe(ws.id);

    expect(() =>
      store.workspaces.create({
        task_id: t.id,
        provider: "local",
        root_path: "/tmp/ws-b",
        name: "ws-b",
      }),
    ).toThrow(WorkspaceConflictError);
  });

  it("detach nulls task_id, frees the unique index, and keeps the row", () => {
    const t = task();
    const ws = store.workspaces.create({
      task_id: t.id,
      provider: "local",
      root_path: "/tmp/ws",
      name: "ws",
    });
    store.workspaces.detach(ws.id);

    const after = store.workspaces.get(ws.id)!;
    expect(after.status).toBe("detached");
    expect(after.task_id).toBeNull();
    expect(store.workspaces.getByTask(t.id)).toBeNull();

    // The freed slot lets a new workspace be created for the same task.
    const ws2 = store.workspaces.create({
      task_id: t.id,
      provider: "local",
      root_path: "/tmp/ws2",
      name: "ws2",
    });
    expect(ws2.id).not.toBe(ws.id);
  });

  it("transitions status with events", () => {
    const t = task();
    const events: string[] = [];
    store.bus.subscribe((e) => events.push(e.event));
    const ws = store.workspaces.create({
      task_id: t.id,
      provider: "tasktree",
      root_path: "/tmp/p",
      name: "p",
      status: "provisioning",
    });
    expect(events).toContain("workspace.provisioning");
    store.workspaces.setStatus(ws.id, "ready");
    expect(events).toContain("workspace.ready");
    store.workspaces.setStatus(ws.id, "error", "boom");
    expect(store.workspaces.get(ws.id)!.error).toBe("boom");
    expect(events).toContain("workspace.error");
  });

  it("upsertFromRef inserts then repairs by path, re-linking detached rows", () => {
    const t = task();
    const ref = {
      provider: "tasktree",
      rootPath: "/tmp/recon",
      name: "recon",
      taskId: t.id,
    };
    const a = store.workspaces.upsertFromRef(ref);
    expect(a.task_id).toBe(t.id);
    // second upsert hits same path → same row
    const b = store.workspaces.upsertFromRef({ ...ref, name: "recon2" });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("recon2");

    store.workspaces.detach(a.id);
    const c = store.workspaces.upsertFromRef(ref);
    expect(c.id).toBe(a.id);
    expect(c.status).toBe("ready");
    expect(c.task_id).toBe(t.id);
  });

  it("stores and round-trips the meta bag", () => {
    const t = task();
    const ws = store.workspaces.create({
      task_id: t.id,
      provider: "tasktree",
      root_path: "/tmp/m",
      name: "m",
      meta: { repos: ["a", "b"], template: "x" },
    });
    expect(store.workspaces.get(ws.id)!.meta).toEqual({ repos: ["a", "b"], template: "x" });
    store.workspaces.setMeta(ws.id, { repos: ["c"] });
    expect(store.workspaces.get(ws.id)!.meta).toEqual({ repos: ["c"] });
  });
});
