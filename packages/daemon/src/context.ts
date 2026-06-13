import type { FastifyRequest } from "fastify";
import type { Store } from "@tq/core";
import { DEFAULT_ACTOR } from "@tq/core";

/**
 * Resolve the acting identity for a request. Precedence:
 *   1. X-TQ-Token → token table lookup
 *   2. X-TQ-Actor header (client-supplied, trusted on localhost)
 *   3. default actor
 */
export function resolveActor(store: Store, req: FastifyRequest): string {
  const token = req.headers["x-tq-token"];
  if (typeof token === "string" && token.length > 0) {
    const row = store.db
      .prepare(`SELECT actor FROM token WHERE token = ?`)
      .get(token) as { actor: string } | undefined;
    if (row) return row.actor;
  }
  const actor = req.headers["x-tq-actor"];
  if (typeof actor === "string" && actor.length > 0) return actor;
  return DEFAULT_ACTOR;
}
