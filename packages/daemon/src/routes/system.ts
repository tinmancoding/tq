import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Store, TqConfig } from "@tq/core";
import { newId, now } from "@tq/core";

export function registerSystemRoutes(
  app: FastifyInstance,
  store: Store,
  cfg: TqConfig,
  startedAt: number,
): void {
  app.get("/api/health", () => {
    const taskCount = (store.db.prepare(`SELECT COUNT(*) AS n FROM task`).get() as { n: number }).n;
    const intakeCount = (
      store.db.prepare(`SELECT COUNT(*) AS n FROM intake`).get() as { n: number }
    ).n;
    const seq = store.events.maxSeq();
    return {
      ok: true,
      version: "0.1.0",
      uptime_sec: Math.round((Date.now() - startedAt) / 1000),
      jobs: store.jobs.counts(),
      counts: { tasks: taskCount, intake: intakeCount },
      seq,
      subscriptions: store.subscriptions.list().map((s) => ({
        consumer_id: s.consumer_id,
        cursor: s.cursor,
        lag: Math.max(0, seq - s.cursor),
        dead_letters: s.dead_letters.length,
        last_seen_at: s.last_seen_at,
      })),
      aws: { configured: !!cfg.aws.region, reachable: null }, // probed in Phase 2
      db_path: cfg.daemon.db_path,
    };
  });

  // Token creation for actor attribution (convenience; localhost is the boundary).
  app.post(
    "/api/tokens",
    { schema: { body: Type.Object({ actor: Type.String({ minLength: 1 }) }) } },
    (req, reply) => {
      const token = newId().replace(/-/g, "");
      const actor = (req.body as { actor: string }).actor;
      store.db
        .prepare(`INSERT INTO token (token, actor, created_at) VALUES (?, ?, ?)`)
        .run(token, actor, now());
      reply.code(201).send({ token, actor });
    },
  );
}
