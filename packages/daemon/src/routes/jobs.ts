import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Store } from "@tq/core";

export function registerJobRoutes(app: FastifyInstance, store: Store): void {
  app.get(
    "/api/triage/jobs",
    {
      schema: {
        querystring: Type.Object({
          status: Type.Optional(
            Type.Union([
              Type.Literal("queued"),
              Type.Literal("running"),
              Type.Literal("done"),
              Type.Literal("error"),
            ]),
          ),
        }),
      },
    },
    (req) => {
      const q = req.query as { status?: never };
      return {
        counts: store.jobs.counts(),
        jobs: store.jobs.list({ status: q.status }),
      };
    },
  );

  app.post("/api/triage/jobs/:id/requeue", (req, reply) => {
    const job = store.jobs.requeue((req.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: "job not found" });
    return job;
  });
}
