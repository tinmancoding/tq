import type { FastifyInstance } from "fastify";
import type { Store } from "@tq/core";

/**
 * Register the GET /api/events SSE endpoint. Every domain event from the bus
 * is streamed to all connected clients. A heartbeat keeps the connection and
 * any proxies alive and doubles as the `daemon.status` signal carrier.
 */
export function registerSse(app: FastifyInstance, store: Store, startedAt: number): void {
  app.get("/api/events", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`: connected\n\n`);

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const unsubscribe = store.bus.subscribe(({ event, data }) => {
      send(event, data);
    });

    const heartbeat = setInterval(() => {
      send("daemon.status", {
        uptime_sec: Math.round((Date.now() - startedAt) / 1000),
        jobs: store.jobs.counts(),
        ts: new Date().toISOString(),
      });
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
