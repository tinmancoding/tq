import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Store } from "@tq/core";
import { INTAKE_STATUSES, TASK_STATUSES } from "@tq/core";
import { resolveActor } from "../context.js";

const IntakeStatusEnum = Type.Union(INTAKE_STATUSES.map((s) => Type.Literal(s)));
const LabelSchema = Type.Object({ key: Type.String(), value: Type.String() });

export function registerIntakeRoutes(app: FastifyInstance, store: Store): void {
  // Create (JSON). Multipart image upload arrives in Phase 2.
  app.post(
    "/api/intake",
    {
      schema: {
        body: Type.Object({
          text: Type.Optional(Type.String()),
          body: Type.Optional(Type.String()),
          source: Type.Optional(Type.String()),
          source_ref: Type.Optional(Type.String()),
          labels: Type.Optional(Type.Record(Type.String(), Type.String())),
          action_verbs: Type.Optional(Type.Array(Type.String())),
        }),
        querystring: Type.Object({
          wait: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body as Record<string, unknown>;
      const { intake } = store.intake.create({
        body: ((b.body as string) ?? (b.text as string)) ?? null,
        source: (b.source as string) ?? "manual",
        source_ref: (b.source_ref as string) ?? null,
        labels: b.labels as Record<string, string> | undefined,
        action_verbs: b.action_verbs as string[] | undefined,
      });
      // ?wait=true would block for triage; triage worker lands in Phase 2, so
      // for now we always return 202 immediately.
      reply.code(202).send(intake);
    },
  );

  app.get(
    "/api/intake",
    {
      schema: {
        querystring: Type.Object({
          status: Type.Optional(IntakeStatusEnum),
          source: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      },
    },
    (req) => {
      const q = req.query as Record<string, string | undefined>;
      return {
        intake: store.intake.list({
          status: q.status as never,
          source: q.source,
          limit: q.limit ? Number(q.limit) : undefined,
          offset: q.offset ? Number(q.offset) : undefined,
        }),
      };
    },
  );

  app.get("/api/intake/:id", (req, reply) => {
    const id = store.intake.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "intake not found" });
    const intake = store.intake.get(id)!;
    return { ...intake, linked_task_ids: store.intake.linkedTaskIds(id) };
  });

  app.post(
    "/api/intake/:id/promote",
    {
      schema: {
        body: Type.Object({
          title: Type.Optional(Type.String()),
          body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          status: Type.Optional(Type.Union(TASK_STATUSES.map((s) => Type.Literal(s)))),
          labels: Type.Optional(Type.Array(LabelSchema)),
        }),
      },
    },
    (req, reply) => {
      const id = store.intake.resolveId((req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "intake not found" });
      const result = store.intake.promote(id, {
        ...(req.body as object),
        created_by: resolveActor(store, req),
      });
      reply.code(201).send(result);
    },
  );

  app.post(
    "/api/intake/:id/link",
    { schema: { body: Type.Object({ task_id: Type.String(), relation: Type.Optional(Type.String()) }) } },
    (req, reply) => {
      const id = store.intake.resolveId((req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "intake not found" });
      const b = req.body as { task_id: string; relation?: string };
      const taskId = store.tasks.resolveId(b.task_id);
      if (!taskId) return reply.code(404).send({ error: "task not found" });
      const result = store.intake.link(id, taskId, b.relation ?? "linked");
      return result;
    },
  );

  app.post(
    "/api/intake/:id/discard",
    { schema: { body: Type.Object({ reason: Type.String() }) } },
    (req, reply) => {
      const id = store.intake.resolveId((req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "intake not found" });
      return store.intake.discard(id, (req.body as { reason: string }).reason);
    },
  );

  app.post("/api/intake/:id/retriage", (req, reply) => {
    const id = store.intake.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "intake not found" });
    return store.intake.retriage(id);
  });
}
