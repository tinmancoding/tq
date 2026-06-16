import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Store } from "@tq/core";
import { ftsSearchTasks, TASK_STATUSES } from "@tq/core";

/**
 * Core keyword search (FTS-only). Semantic/hybrid search is served by the
 * @tq/ext-search-semantic extension at /api/ext/search-semantic/search, which
 * fuses these results with its own vector index.
 */
export function registerSearchRoutes(app: FastifyInstance, store: Store): void {
  app.get(
    "/api/search",
    {
      schema: {
        querystring: Type.Object({
          q: Type.String(),
          status: Type.Optional(Type.Union(TASK_STATUSES.map((s) => Type.Literal(s)))),
          label: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
      },
    },
    (req) => {
      const q = req.query as Record<string, string | undefined>;
      const label = parseLabel(q.label);
      return ftsSearchTasks(store.db, store.tasks, q.q ?? "", {
        status: q.status as never,
        label: label ?? undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      });
    },
  );
}

function parseLabel(s?: string): { key: string; value: string } | null {
  if (!s) return null;
  const idx = s.indexOf(":");
  if (idx <= 0) return null;
  return { key: s.slice(0, idx), value: s.slice(idx + 1) };
}
