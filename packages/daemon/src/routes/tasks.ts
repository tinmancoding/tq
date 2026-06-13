import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Store } from "@tq/core";
import { PRIORITIES, TASK_STATUSES } from "@tq/core";
import { resolveActor } from "../context.js";

const StatusEnum = Type.Union(TASK_STATUSES.map((s) => Type.Literal(s)));
const PriorityEnum = Type.Union(PRIORITIES.map((p) => Type.Literal(p)));
const LabelSchema = Type.Object({ key: Type.String(), value: Type.String() });

export function registerTaskRoutes(app: FastifyInstance, store: Store): void {
  // Create
  app.post(
    "/api/tasks",
    {
      schema: {
        body: Type.Object({
          title: Type.String({ minLength: 1 }),
          body: Type.Optional(Type.String()),
          status: Type.Optional(StatusEnum),
          priority: Type.Optional(PriorityEnum),
          due_at: Type.Optional(Type.String()),
          labels: Type.Optional(Type.Array(LabelSchema)),
        }),
      },
    },
    (req, reply) => {
      const b = req.body as Record<string, unknown>;
      const task = store.tasks.create({
        title: b.title as string,
        body: (b.body as string) ?? null,
        status: b.status as never,
        priority: b.priority as never,
        due_at: (b.due_at as string) ?? null,
        labels: (b.labels as never) ?? [],
        created_by: resolveActor(store, req),
      });
      reply.code(201).send(task);
    },
  );

  // List (with optional board grouping)
  app.get(
    "/api/tasks",
    {
      schema: {
        querystring: Type.Object({
          status: Type.Optional(StatusEnum),
          label: Type.Optional(Type.String()), // "key:value"
          group: Type.Optional(Type.Literal("status")),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      },
    },
    (req) => {
      const q = req.query as Record<string, string | undefined>;
      const label = parseLabel(q.label);
      const tasks = store.tasks.list({
        status: q.status as never,
        label: label ?? undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      });
      if (q.group === "status") {
        const board: Record<string, unknown[]> = {};
        for (const s of TASK_STATUSES) board[s] = [];
        for (const t of tasks) board[t.status]!.push(t);
        return { group: "status", board };
      }
      return { tasks };
    },
  );

  // Detail
  app.get("/api/tasks/:id", (req, reply) => {
    const id = resolveTaskId(store, (req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "task not found" });
    const task = store.tasks.get(id)!;
    return {
      ...task,
      activity: store.tasks.listActivity(id),
    };
  });

  // Patch
  app.patch(
    "/api/tasks/:id",
    {
      schema: {
        body: Type.Object({
          title: Type.Optional(Type.String({ minLength: 1 })),
          body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          priority: Type.Optional(Type.Union([PriorityEnum, Type.Null()])),
          due_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          snooze_until: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
      },
    },
    (req, reply) => {
      const id = resolveTaskId(store, (req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "task not found" });
      return store.tasks.update(id, req.body as never);
    },
  );

  // Move (status + rank)
  app.post(
    "/api/tasks/:id/move",
    {
      schema: {
        body: Type.Object({
          status: StatusEnum,
          board_rank: Type.Optional(Type.String()),
        }),
      },
    },
    (req, reply) => {
      const id = resolveTaskId(store, (req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "task not found" });
      const b = req.body as { status: never; board_rank?: string };
      return store.tasks.move(id, b.status, b.board_rank, resolveActor(store, req));
    },
  );

  // Delete (soft → dropped, ?hard=true purges)
  app.delete("/api/tasks/:id", (req, reply) => {
    const id = resolveTaskId(store, (req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "task not found" });
    const hard = (req.query as { hard?: string }).hard === "true";
    store.tasks.remove(id, hard);
    return reply.code(204).send();
  });

  // Labels
  app.post(
    "/api/tasks/:id/labels",
    { schema: { body: LabelSchema } },
    (req, reply) => {
      const id = resolveTaskId(store, (req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "task not found" });
      return store.tasks.addLabel(id, req.body as never);
    },
  );

  app.delete("/api/tasks/:id/labels/:key/:value", (req, reply) => {
    const p = req.params as { id: string; key: string; value: string };
    const id = resolveTaskId(store, p.id);
    if (!id) return reply.code(404).send({ error: "task not found" });
    return store.tasks.removeLabel(id, { key: p.key, value: p.value });
  });

  // Refs
  app.post(
    "/api/tasks/:id/refs",
    {
      schema: {
        body: Type.Object({
          kind: Type.String(),
          url: Type.String(),
          external_id: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          meta: Type.Optional(Type.Unknown()),
        }),
      },
    },
    (req, reply) => {
      const id = resolveTaskId(store, (req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "task not found" });
      const ref = store.tasks.addRef(id, req.body as never);
      reply.code(201).send(ref);
    },
  );

  // Activity
  app.post(
    "/api/tasks/:id/activity",
    {
      schema: {
        body: Type.Object({
          entry_type: Type.Union([Type.Literal("worklog"), Type.Literal("comment")]),
          body: Type.String({ minLength: 1 }),
        }),
      },
    },
    (req, reply) => {
      const id = resolveTaskId(store, (req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "task not found" });
      const b = req.body as { entry_type: "worklog" | "comment"; body: string };
      const act = store.tasks.addActivity(id, {
        entry_type: b.entry_type,
        actor: resolveActor(store, req),
        body: b.body,
      });
      reply.code(201).send(act);
    },
  );

  app.get("/api/tasks/:id/activity", (req, reply) => {
    const id = resolveTaskId(store, (req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "task not found" });
    return { activity: store.tasks.listActivity(id) };
  });
}

function parseLabel(s?: string): { key: string; value: string } | null {
  if (!s) return null;
  const idx = s.indexOf(":");
  if (idx <= 0) return null;
  return { key: s.slice(0, idx), value: s.slice(idx + 1) };
}

function resolveTaskId(store: Store, raw: string): string | null {
  return store.tasks.resolveId(raw);
}
