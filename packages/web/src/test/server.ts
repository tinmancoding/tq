import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import type { IntakeDetail, Task } from "../api/types";

// A mutable in-memory fixture the handlers read/write, so tests can assert
// that mutations hit the server with the right payloads.
export const db = {
  intakeDetail: null as IntakeDetail | null,
  triaged: [] as IntakeDetail[],
  board: {} as Record<string, Task[]>,
  calls: [] as { method: string; url: string; body: unknown }[],
};

export function resetDb() {
  db.intakeDetail = null;
  db.triaged = [];
  db.board = {};
  db.calls = [];
}

const base = "*";

export const server = setupServer(
  http.get(`${base}/api/intake`, ({ request }) => {
    const status = new URL(request.url).searchParams.get("status");
    if (status === "triaged") return HttpResponse.json({ intake: db.triaged });
    return HttpResponse.json({ intake: [] });
  }),

  http.get(`${base}/api/intake/:id`, ({ params }) => {
    const found =
      db.triaged.find((i) => i.id === params.id) ?? db.intakeDetail;
    return HttpResponse.json(found);
  }),

  http.post(`${base}/api/intake/:id/promote`, async ({ request, params }) => {
    db.calls.push({
      method: "POST",
      url: `/intake/${params.id}/promote`,
      body: await request.json(),
    });
    db.triaged = db.triaged.filter((i) => i.id !== params.id);
    return HttpResponse.json(
      { intake: { id: params.id, status: "promoted" }, taskId: "task-new" },
      { status: 201 },
    );
  }),

  http.post(`${base}/api/intake/:id/discard`, async ({ request, params }) => {
    db.calls.push({
      method: "POST",
      url: `/intake/${params.id}/discard`,
      body: await request.json(),
    });
    db.triaged = db.triaged.filter((i) => i.id !== params.id);
    return HttpResponse.json({ ok: true });
  }),

  http.post(`${base}/api/intake/:id/retriage`, ({ params }) => {
    db.calls.push({ method: "POST", url: `/intake/${params.id}/retriage`, body: null });
    return HttpResponse.json({ ok: true });
  }),

  http.get(`${base}/api/tasks`, ({ request }) => {
    const group = new URL(request.url).searchParams.get("group");
    if (group === "status") {
      return HttpResponse.json({ group: "status", board: db.board });
    }
    return HttpResponse.json({ tasks: [] });
  }),

  http.post(`${base}/api/tasks/:id/move`, async ({ request, params }) => {
    const body = (await request.json()) as { status: string; board_rank?: string };
    db.calls.push({ method: "POST", url: `/tasks/${params.id}/move`, body });
    // Reflect the move in the in-memory board for follow-up assertions.
    for (const col of Object.keys(db.board)) {
      const idx = db.board[col]!.findIndex((t) => t.id === params.id);
      if (idx !== -1) {
        const [t] = db.board[col]!.splice(idx, 1);
        const moved = { ...t!, status: body.status as Task["status"], board_rank: body.board_rank ?? null };
        (db.board[body.status] ??= []).push(moved);
        return HttpResponse.json(moved);
      }
    }
    return HttpResponse.json({ id: params.id, ...body });
  }),

  http.get(`${base}/api/health`, () =>
    HttpResponse.json({
      ok: true,
      version: "test",
      uptime_sec: 1,
      jobs: { queued: 0, running: 0, done: 0, error: 0 },
      counts: { tasks: 0, intake: 0 },
      aws: { configured: true, reachable: true },
      db_path: ":memory:",
    }),
  ),
);
