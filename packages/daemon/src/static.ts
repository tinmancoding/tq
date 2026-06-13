import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/**
 * Serve the built web app (packages/web/dist) at `/`. The web app uses hash
 * routing, so the server only ever sees `/` and `/assets/*` — but we still add
 * an SPA fallback for any non-API GET so direct asset/deep links resolve.
 *
 * Registered synchronously (queued like other plugins) so `app.ready()` awaits
 * it. Degrades gracefully: if `dist` is missing (pure dev via Vite), it's a
 * no-op and the daemon serves the API only.
 */
export function registerStatic(app: FastifyInstance, distDir: string): boolean {
  if (!existsSync(distDir)) return false;

  void app.register(fastifyStatic, {
    root: distDir,
    prefix: "/",
    wildcard: false,
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not found", detail: req.url });
  });

  return true;
}
