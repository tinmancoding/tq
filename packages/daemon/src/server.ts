import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Store, TqConfig, Embedder } from "@tq/core";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerIntakeRoutes } from "./routes/intake.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerSse } from "./sse.js";

export interface BuildOptions {
  store: Store;
  config: TqConfig;
  startedAt?: number;
  logger?: boolean;
  embedder?: Embedder;
}

/** Construct the Fastify app with all routes registered (no listen). */
export function buildServer(opts: BuildOptions): FastifyInstance {
  const startedAt = opts.startedAt ?? Date.now();
  const app = Fastify({
    logger: opts.logger ?? false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status === 400 || err.validation) {
      reply.code(400).send({ error: "validation", detail: err.message });
      return;
    }
    reply.code(status).send({ error: err.name, detail: err.message });
  });

  // Multipart support for intake image uploads (10 MB/file, 10 files).
  void app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  });

  registerSystemRoutes(app, opts.store, opts.config, startedAt);
  registerTaskRoutes(app, opts.store);
  registerIntakeRoutes(app, opts.store);
  registerSearchRoutes(app, opts.store, opts.embedder);
  registerJobRoutes(app, opts.store);
  registerAttachmentRoutes(app, opts.store);
  registerSse(app, opts.store, startedAt);

  return app;
}
