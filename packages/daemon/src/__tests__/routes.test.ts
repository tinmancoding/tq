import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store, defaultConfig } from "@tq/core";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

let store: Store;
let app: FastifyInstance;

beforeEach(async () => {
  store = Store.open({ path: ":memory:" });
  app = buildServer({ store, config: defaultConfig(), logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
});

describe("task routes", () => {
  it("creates, lists, and shows a task", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Hello", labels: [{ key: "project", value: "x" }] },
    });
    expect(create.statusCode).toBe(201);
    const task = create.json();
    expect(task.title).toBe("Hello");

    const list = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(list.json().tasks).toHaveLength(1);

    const show = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(show.json().id).toBe(task.id);
    expect(show.json().activity).toEqual([]);
  });

  it("returns board grouping with ?group=status", async () => {
    await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "a" } });
    const res = await app.inject({ method: "GET", url: "/api/tasks?group=status" });
    const body = res.json();
    expect(body.group).toBe("status");
    expect(body.board.backlog).toHaveLength(1);
    expect(body.board.done).toEqual([]);
  });

  it("moves a task and records system activity", async () => {
    const t = (
      await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "m" } })
    ).json();
    const moved = await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/move`,
      payload: { status: "doing" },
    });
    expect(moved.json().status).toBe("doing");
    const acts = await app.inject({ method: "GET", url: `/api/tasks/${t.id}/activity` });
    expect(acts.json().activity[0].entry_type).toBe("system");
  });

  it("attributes activity to X-TQ-Actor header", async () => {
    const t = (
      await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "a" } })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/activity`,
      headers: { "x-tq-actor": "agent:pr-reviewer" },
      payload: { entry_type: "worklog", body: "CI green" },
    });
    const acts = (await app.inject({ method: "GET", url: `/api/tasks/${t.id}/activity` })).json();
    expect(acts.activity[0].actor).toBe("agent:pr-reviewer");
  });

  it("404s for unknown task", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tasks/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("400s on invalid body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/tasks", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("intake + search routes", () => {
  it("captures intake with 202 and lists it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/intake",
      payload: { text: "review the auth PR" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("new");

    const list = await app.inject({ method: "GET", url: "/api/intake?status=new" });
    expect(list.json().intake).toHaveLength(1);
  });

  it("promotes an intake into a task", async () => {
    const intake = (
      await app.inject({ method: "POST", url: "/api/intake", payload: { text: "do x" } })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/intake/${intake.id}/promote`,
      payload: { title: "Do X" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().taskId).toBeTruthy();
  });

  it("serves the triage transcript and omits it from list/detail payloads", async () => {
    const intake = (
      await app.inject({ method: "POST", url: "/api/intake", payload: { text: "trace me" } })
    ).json();
    store.intake.setTriageTrace(intake.id, [
      { kind: "thought", text: "hello" },
      { kind: "tool_call", tool: "search_tasks", args: { query: "x" } },
    ]);

    const trace = await app.inject({ method: "GET", url: `/api/intake/${intake.id}/trace` });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().trace).toHaveLength(2);
    expect(trace.json().trace[0]).toEqual({ kind: "thought", text: "hello" });

    // Trace is large; it must not bloat the list or detail responses.
    const list = await app.inject({ method: "GET", url: "/api/intake" });
    expect(list.json().intake[0]).not.toHaveProperty("triage_trace");
    const detail = await app.inject({ method: "GET", url: `/api/intake/${intake.id}` });
    expect(detail.json()).not.toHaveProperty("triage_trace");
  });

  it("hybrid search returns fts hits flagged vector:false", async () => {
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "Investigate cookie expiry" },
    });
    const res = await app.inject({ method: "GET", url: "/api/search?q=cookie" });
    const body = res.json();
    expect(body.vector).toBe(false);
    expect(body.hits.length).toBe(1);
  });
});

describe("health", () => {
  it("reports ok with counts", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json().ok).toBe(true);
    expect(res.json().counts).toHaveProperty("tasks");
  });
});

describe("attachment serving", () => {
  it("serves a stored blob by sha with its mime type", async () => {
    const sha = store.attachments.store(Buffer.from("PNGDATA"), { mime: "image/png" });
    const res = await app.inject({ method: "GET", url: `/api/attachments/${sha}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body).toBe("PNGDATA");
  });

  it("400s on a malformed sha and 404s on a missing one", async () => {
    const bad = await app.inject({ method: "GET", url: "/api/attachments/not-a-hash" });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "GET",
      url: `/api/attachments/${"a".repeat(64)}`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
