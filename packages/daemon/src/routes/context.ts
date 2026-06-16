import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Store } from "@tq/core";
import { existsSync, readFileSync } from "node:fs";
import { resolveActor } from "../context.js";

/**
 * Context store endpoints (Phase C):
 *   PUT  /api/tasks/:id/context/:namespace      — set an extension's slot
 *   PUT  /api/intake/:id/context/:namespace
 *   GET  /api/blobs/:sha                        — resolve a claim-check blob
 *
 * The body is the raw JSON value for the namespace (object/array/scalar). Core
 * validates size and spills oversized values to the blob store, then appends a
 * ContextUpdated event and folds the entity's `context` column.
 */
export function registerContextRoutes(app: FastifyInstance, store: Store): void {
  const scopes = [
    { scope: "task" as const, base: "/api/tasks", resolve: (raw: string) => store.tasks.resolveId(raw) },
    { scope: "intake" as const, base: "/api/intake", resolve: (raw: string) => store.intake.resolveId(raw) },
  ];

  for (const { scope, base, resolve } of scopes) {
    app.put(
      `${base}/:id/context/:namespace`,
      {
        schema: {
          params: Type.Object({ id: Type.String(), namespace: Type.String({ minLength: 1 }) }),
          body: Type.Unknown(),
        },
      },
      (req, reply) => {
        const { id: raw, namespace } = req.params as { id: string; namespace: string };
        const id = resolve(raw);
        if (!id) return reply.code(404).send({ error: `${scope} not found` });
        const res = store.context.set(scope, id, namespace, req.body, resolveActor(store, req));
        if (!res) return reply.code(404).send({ error: `${scope} not found` });
        return { context: res.context, spilled: res.spilled };
      },
    );
  }

  // Resolve a claim-check blob by sha (content-addressed; immutable, cacheable).
  app.get("/api/blobs/:sha", (req, reply) => {
    const sha = (req.params as { sha: string }).sha;
    const meta = store.attachments.meta(sha);
    const path = store.attachments.filePath(sha);
    if (!meta || !existsSync(path)) return reply.code(404).send({ error: "blob not found" });
    reply.header("Content-Type", meta.mime);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return readFileSync(path);
  });
}
