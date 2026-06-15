import type { FastifyInstance } from "fastify";
import type { Store, EventRow } from "@tq/core";

interface StreamFilters {
  types?: string[];
  scopeType?: string;
}

function matches(ev: EventRow, f: StreamFilters): boolean {
  if (f.scopeType && ev.scope_type !== f.scopeType) return false;
  if (f.types && f.types.length > 0 && !f.types.includes(ev.type)) return false;
  return true;
}

/**
 * GET /api/events?since=<seq>&types=A,B&scope_type=task
 *
 * Durable event stream (Q5): replays the backlog from `since` (exclusive) in
 * global `seq` order, then holds the connection open and live-tails new events
 * (delivered via the bus `@event` channel after each commit). Omitting `since`
 * starts live-only from the current head. Filtered responses still advance the
 * client past skipped events (we send the latest seq we've reached as a comment
 * cursor + on each event), so a consumer never re-scans gaps.
 */
export function registerEventRoutes(app: FastifyInstance, store: Store, startedAt: number): void {
  app.get("/api/events", (req, reply) => {
    const q = req.query as { since?: string; types?: string; scope_type?: string };
    const lastEventId = req.headers["last-event-id"];
    const since = q.since ?? (typeof lastEventId === "string" ? lastEventId : undefined);
    const filters: StreamFilters = {
      types: q.types ? q.types.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      scopeType: q.scope_type,
    };

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`: connected\n\n`);

    let lastSent = 0; // highest seq the client has been advanced past

    const writeEvent = (ev: EventRow): void => {
      lastSent = Math.max(lastSent, ev.seq);
      reply.raw.write(`id: ${ev.seq}\n`);
      reply.raw.write(`event: ${ev.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };

    // Buffer live events that arrive while we replay the backlog, to avoid a gap.
    let caughtUp = false;
    const buffered: EventRow[] = [];
    const onEvent = (data: unknown): void => {
      const ev = data as EventRow;
      if (!caughtUp) {
        buffered.push(ev);
        return;
      }
      if (ev.seq > lastSent && matches(ev, filters)) writeEvent(ev);
    };
    const unsubscribe = store.bus.subscribe(({ event, data }) => {
      if (event === "@event") onEvent(data);
    });

    // Replay the backlog (only when `since` is provided).
    const head = store.events.maxSeq();
    if (since !== undefined) {
      let cursor = Number(since) || 0;
      for (;;) {
        const batch = store.events.read({
          since: cursor,
          types: filters.types,
          scopeType: filters.scopeType,
          limit: 500,
        });
        for (const ev of batch) if (ev.seq <= head) writeEvent(ev);
        if (batch.length < 500 || (batch.at(-1)?.seq ?? head) >= head) break;
        cursor = batch.at(-1)!.seq;
      }
    }
    // Advance the cursor to the snapshot head even if filtered out everything.
    if (head > lastSent) {
      lastSent = head;
      reply.raw.write(`: cursor ${head}\n\n`);
    }

    // Flush anything buffered during replay, then go live.
    caughtUp = true;
    for (const ev of buffered) if (ev.seq > lastSent && matches(ev, filters)) writeEvent(ev);

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\n`);
      reply.raw.write(
        `data: ${JSON.stringify({
          seq: store.events.maxSeq(),
          uptime_sec: Math.round((Date.now() - startedAt) / 1000),
          jobs: store.jobs.counts(),
          ts: new Date().toISOString(),
        })}\n\n`,
      );
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
