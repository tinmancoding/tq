import { describe, it, expect } from "vitest";
import {
  PRIORITIES as WIRE_PRIORITIES,
  TASK_STATUSES as WIRE_STATUSES,
  createCoreClient,
  ApiError,
} from "@tq/contract";

describe("contract enums", () => {
  it("expose the task statuses and priorities as readonly tuples", () => {
    expect([...WIRE_STATUSES]).toEqual(["backlog", "next", "doing", "blocked", "done", "dropped"]);
    expect([...WIRE_PRIORITIES]).toEqual(["high", "med", "low"]);
  });
});

describe("createCoreClient", () => {
  function mockFetch(captured: { calls: Array<{ url: string; init: RequestInit }> }) {
    return (url: string | URL, init?: RequestInit): Promise<Response> => {
      captured.calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify({ id: "t1", title: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
  }

  it("builds /api paths, sends actor header + JSON body", async () => {
    const captured = { calls: [] as Array<{ url: string; init: RequestInit }> };
    const c = createCoreClient({
      baseUrl: "http://127.0.0.1:7788",
      fetch: mockFetch(captured) as typeof fetch,
      actor: "human:laci",
    });
    await c.tasks.create({ title: "hello" });
    const call = captured.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:7788/api/tasks");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["X-TQ-Actor"]).toBe("human:laci");
    expect(JSON.parse(call.init.body as string)).toEqual({ title: "hello" });
  });

  it("composes query strings + the events SSE url", () => {
    const c = createCoreClient({ baseUrl: "http://h" });
    expect(c.events.url({ since: 5, types: ["TaskCreated", "TaskMoved"], scopeType: "task" })).toBe(
      "http://h/api/events?since=5&types=TaskCreated%2CTaskMoved&scope_type=task",
    );
    expect(c.events.url()).toBe("http://h/api/events");
  });

  it("throws ApiError carrying the daemon's error detail", async () => {
    const c = createCoreClient({
      baseUrl: "",
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "task not found" }), { status: 404 }),
        )) as typeof fetch,
    });
    await expect(c.tasks.get("nope")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      detail: "task not found",
    });
    expect(new ApiError(500, "boom")).toBeInstanceOf(Error);
  });
});
