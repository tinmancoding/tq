import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Intake, Store } from "@tq/core";
import { INTAKE_STATUSES, TASK_STATUSES } from "@tq/core";
import { resolveActor } from "../context.js";

const IntakeStatusEnum = Type.Union(INTAKE_STATUSES.map((s) => Type.Literal(s)));
const LabelSchema = Type.Object({ key: Type.String(), value: Type.String() });

export function registerIntakeRoutes(app: FastifyInstance, store: Store): void {
  // Create — accepts JSON or multipart/form-data (text + image files).
  app.post(
    "/api/intake",
    { schema: { querystring: Type.Object({ wait: Type.Optional(Type.Boolean()) }) } },
    async (req, reply) => {
      if (typeof req.isMultipart === "function" && req.isMultipart()) {
        const fields: Record<string, string> = {};
        const images: { buf: Buffer; mime: string; filename: string | null }[] = [];
        for await (const part of req.parts()) {
          if (part.type === "file") {
            images.push({
              buf: await part.toBuffer(),
              mime: part.mimetype || "application/octet-stream",
              filename: part.filename ?? null,
            });
          } else {
            fields[part.fieldname] = String(part.value);
          }
        }
        const { intake } = store.intake.create({
          body: fields.text ?? fields.body ?? null,
          source: fields.source ?? "manual",
          labels: parseJsonField<Record<string, string>>(fields.labels),
          action_verbs: parseJsonField<string[]>(fields.verbs),
          deferTriage: true,
        });
        images.forEach((img, i) => {
          const sha = store.attachments.store(img.buf, { mime: img.mime });
          store.attachments.link(intake.id, sha, img.filename, i);
        });
        store.intake.queueTriage(intake.id);
        reply.code(202).send(store.intake.get(intake.id));
        return;
      }

      // JSON path
      const b = (req.body ?? {}) as Record<string, unknown>;
      const { intake } = store.intake.create({
        body: ((b.body as string) ?? (b.text as string)) ?? null,
        source: (b.source as string) ?? "manual",
        source_ref: (b.source_ref as string) ?? null,
        labels: b.labels as Record<string, string> | undefined,
        action_verbs: b.action_verbs as string[] | undefined,
      });
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
        intake: store.intake
          .list({
            status: q.status as never,
            source: q.source,
            limit: q.limit ? Number(q.limit) : undefined,
            offset: q.offset ? Number(q.offset) : undefined,
          })
          .map((i) => withTriageContext(i)),
      };
    },
  );

  app.get("/api/intake/:id", (req, reply) => {
    const id = store.intake.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "intake not found" });
    const intake = store.intake.get(id)!;
    return {
      ...withTriageContext(intake),
      linked_task_ids: store.intake.linkedTaskIds(id),
      attachments: store.attachments.forIntake(id),
    };
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
      return store.intake.link(id, taskId, b.relation ?? "linked");
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

  // Mark an intake triaged (used by the triage extension's "review" outcome).
  app.post("/api/intake/:id/triaged", (req, reply) => {
    const id = store.intake.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "intake not found" });
    return store.intake.markTriaged(id);
  });

  // Triage LLM session transcript (observability) — fetched lazily by the UI.
  // Stored in context.triage_trace by the triage extension (may be spilled).
  app.get("/api/intake/:id/trace", (req, reply) => {
    const id = store.intake.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "intake not found" });
    const trace = store.context.getValue("intake", id, "triage_trace");
    return { trace: Array.isArray(trace) ? trace : [] };
  });
}

/** Surface the triage result/error from the context bag (written by the triage
 *  extension) as `triage`/`triage_error` wire fields, so existing clients keep
 *  working now that the legacy columns are gone. */
function withTriageContext(intake: Intake): Intake & { triage: unknown; triage_error: string | null } {
  const ctx = (intake.context ?? {}) as Record<string, unknown>;
  const triage = ctx.triage;
  const triageError = ctx.triage_error;
  return {
    ...intake,
    triage:
      triage && !(typeof triage === "object" && "$ref" in (triage as object)) ? triage : null,
    triage_error: typeof triageError === "string" ? triageError : null,
  };
}

function parseJsonField<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
