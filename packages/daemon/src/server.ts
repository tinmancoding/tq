import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Store, TqConfig, Embedder } from "@tq/core";
import { daemonBaseUrl } from "@tq/core";
import type { ExtensionDefinition } from "@tq/extension-sdk";
import { createExtensionHost, type ExtensionHost } from "./extensions/host.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerIntakeRoutes } from "./routes/intake.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerContextRoutes } from "./routes/context.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerStatic } from "./static.js";

export interface BuildOptions {
  store: Store;
  config: TqConfig;
  startedAt?: number;
  logger?: boolean;
  embedder?: Embedder;
  webDist?: string;
  /** Extension definitions available to host; enabled per `[extensions.<name>]`. */
  extensions?: ExtensionDefinition[];
  /** Override fetch for extensions' CoreClient (tests route to app.inject). */
  coreFetch?: typeof fetch;
}

/** The Fastify app, decorated with the extension host (call host.start() after listen). */
export type TqServer = FastifyInstance & { tqExtensionHost: ExtensionHost };

/** Construct the Fastify app with all routes registered (no listen). */
export function buildServer(opts: BuildOptions): TqServer {
  const startedAt = opts.startedAt ?? Date.now();
  const app = Fastify({
    logger: opts.logger ?? false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Stamp every JSON read response with the as-of global seq, so clients can
  // snapshot-then-tail (read state, then GET /api/events?since=<seq>).
  app.addHook("onSend", (req, reply, payload, done) => {
    if (req.method === "GET" && !reply.getHeader("x-tq-seq")) {
      reply.header("X-TQ-Seq", String(opts.store.events.maxSeq()));
    }
    done(null, payload);
  });

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
  registerContextRoutes(app, opts.store);
  registerEventRoutes(app, opts.store, startedAt);

  // Extension host: registers the /api/ext/<name>/* gateway + /api/extensions
  // discovery now; consuming the event log begins when host.start() is called
  // (after the server is listening).
  const host = createExtensionHost({
    app,
    store: opts.store,
    cfg: opts.config,
    selfBaseUrl: daemonBaseUrl(opts.config),
    available: opts.extensions ?? [],
    coreFetch: opts.coreFetch,
  });
  app.decorate("tqExtensionHost", host);

  if (opts.webDist) registerStatic(app, opts.webDist);

  return app as TqServer;
}
