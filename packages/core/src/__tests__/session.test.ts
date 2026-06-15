import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../store.js";

function freshStore(): Store {
  return Store.open({ path: ":memory:" });
}

describe("SessionRepo", () => {
  let store: Store;
  let taskId: string;
  let wsId: string;
  beforeEach(() => {
    store = freshStore();
    taskId = store.tasks.create({ title: "t" }).id;
    wsId = store.workspaces.create({
      task_id: taskId,
      provider: "local",
      root_path: "/tmp/ws",
      name: "ws",
    }).id;
  });

  it("upserts idempotently by id and emits discovered then updated", () => {
    const events: string[] = [];
    store.bus.subscribe((e) => events.push(e.event));

    const first = store.sessions.upsert({
      id: "sess-1",
      task_id: taskId,
      workspace_id: wsId,
      session_file: "/tmp/ws/a.jsonl",
      cwd: "/tmp/ws",
      message_count: 2,
      last_activity_at: "2026-01-01T00:00:00.000Z",
    });
    expect(first.created).toBe(true);
    expect(events).toContain("session.discovered");

    const second = store.sessions.upsert({
      id: "sess-1",
      session_file: "/tmp/ws/a.jsonl",
      cwd: "/tmp/ws",
      message_count: 5,
      last_activity_at: "2026-01-02T00:00:00.000Z",
    });
    expect(second.created).toBe(false);
    expect(second.session.message_count).toBe(5);
    expect(events).toContain("session.updated");
  });

  it("listForTask orders by last_activity_at desc", () => {
    store.sessions.upsert({
      id: "old",
      task_id: taskId,
      workspace_id: wsId,
      session_file: "/tmp/ws/old.jsonl",
      cwd: "/tmp/ws",
      last_activity_at: "2026-01-01T00:00:00.000Z",
    });
    store.sessions.upsert({
      id: "new",
      task_id: taskId,
      workspace_id: wsId,
      session_file: "/tmp/ws/new.jsonl",
      cwd: "/tmp/ws",
      last_activity_at: "2026-02-01T00:00:00.000Z",
    });
    const list = store.sessions.listForTask(taskId);
    expect(list.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("tombstones rows whose file disappeared", () => {
    store.sessions.upsert({
      id: "gone",
      task_id: taskId,
      workspace_id: wsId,
      session_file: "/tmp/ws/gone.jsonl",
      cwd: "/tmp/ws",
    });
    store.sessions.upsert({
      id: "kept",
      task_id: taskId,
      workspace_id: wsId,
      session_file: "/tmp/ws/kept.jsonl",
      cwd: "/tmp/ws",
    });
    const n = store.sessions.markTombstoned(wsId, ["/tmp/ws/kept.jsonl"]);
    expect(n).toBe(1);
    expect(store.sessions.get("gone")!.file_present).toBe(false);
    expect(store.sessions.get("gone")!.status).toBe("ended");
    expect(store.sessions.get("kept")!.file_present).toBe(true);
  });
});
