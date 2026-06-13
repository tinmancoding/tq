import type { FastifyInstance } from "fastify";
import type { Store } from "@tq/core";
import { existsSync, readFileSync } from "node:fs";

export function registerAttachmentRoutes(app: FastifyInstance, store: Store): void {
  // Serve a blob by content hash (immutable, cacheable). No path traversal:
  // the sha is validated and only used as a lookup key.
  app.get("/api/attachments/:sha256", (req, reply) => {
    const sha = (req.params as { sha256: string }).sha256;
    if (!/^[a-f0-9]{64}$/.test(sha)) {
      return reply.code(400).send({ error: "invalid sha256" });
    }
    const meta = store.attachments.meta(sha);
    const path = store.attachments.filePath(sha);
    if (!meta || !existsSync(path)) {
      return reply.code(404).send({ error: "attachment not found" });
    }
    reply
      .header("Content-Type", meta.mime)
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(readFileSync(path));
  });
}
