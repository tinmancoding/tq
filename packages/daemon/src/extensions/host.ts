import type { FastifyInstance } from "fastify";
import type { Store, EventRow, TqConfig } from "@tq/core";
import { createCoreClient } from "@tq/contract";
import type {
  EventEnvelope,
  EventFilter,
  EventHandler,
  ExtensionContext,
  ExtensionDefinition,
  ExtRequest,
  ExtRoute,
} from "@tq/extension-sdk";

interface Registration {
  filter: EventFilter;
  handler: EventHandler;
}

function envelopeMatches(ev: EventRow, f: EventFilter): boolean {
  if (f.scopeType && ev.scope_type !== f.scopeType) return false;
  if (f.types && f.types.length > 0 && !f.types.includes(ev.type)) return false;
  return true;
}

/**
 * Per-extension consumer: replays the log from the committed cursor, then
 * live-tails the bus. Events are processed strictly in `seq` order; a handler
 * that keeps failing is dead-lettered and the cursor advances past the poison
 * (at-least-once + idempotent consumers, Q5). One subscription/consumer id per
 * extension.
 */
class ExtensionRunner {
  private readonly queue: EventRow[] = [];
  private lastSeen = 0;
  private ready = false;
  private draining = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    readonly name: string,
    private readonly regs: Registration[],
    private readonly store: Store,
    private readonly maxRetries: number,
    private readonly log: (msg: string, meta?: unknown) => void,
  ) {}

  get pending(): number {
    return this.queue.length + (this.draining ? 1 : 0);
  }

  start(): void {
    // Subscribe first so nothing committed during replay is missed, then read
    // the backlog. (Single-threaded + synchronous writes mean no live event can
    // actually interleave with the synchronous read below, but this is safe.)
    this.unsubscribe = this.store.bus.subscribe(({ event, data }) => {
      if (event === "@event") this.offer(data as EventRow);
    });
    const cursor = this.store.subscriptions.get(this.name)?.cursor ?? 0;
    for (const ev of this.store.events.read({ since: cursor, limit: 100_000 })) this.offer(ev);
    this.ready = true;
    void this.drain();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private offer(ev: EventRow): void {
    if (ev.seq <= this.lastSeen) return; // monotonic; dedupe replay/live overlap
    this.lastSeen = ev.seq;
    this.queue.push(ev);
    if (this.ready) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const ev = this.queue[0]!;
        await this.dispatch(ev);
        this.queue.shift();
        this.store.subscriptions.commit(this.name, ev.seq);
      }
    } finally {
      this.draining = false;
    }
  }

  private async dispatch(ev: EventRow): Promise<void> {
    const envelope = ev as unknown as EventEnvelope;
    for (const reg of this.regs) {
      if (!envelopeMatches(ev, reg.filter)) continue;
      let attempt = 0;
      for (;;) {
        try {
          await reg.handler(envelope);
          break;
        } catch (err) {
          attempt++;
          if (attempt > this.maxRetries) {
            const msg = err instanceof Error ? err.message : String(err);
            this.store.subscriptions.recordDeadLetter(this.name, ev.seq, msg);
            this.log(`dead-lettered event seq=${ev.seq} type=${ev.type}: ${msg}`);
            break;
          }
        }
      }
    }
  }
}

export interface ExtensionHostOptions {
  app: FastifyInstance;
  store: Store;
  cfg: TqConfig;
  /** Base URL extensions' CoreClient targets (this daemon). */
  selfBaseUrl: string;
  /** Available extension definitions; enabled per `[extensions.<name>]`. */
  available: ExtensionDefinition[];
  /** Override fetch for the injected CoreClient (tests route to app.inject). */
  coreFetch?: typeof fetch;
  maxRetries?: number;
  log?: (msg: string, meta?: unknown) => void;
}

interface LoadedExtension {
  def: ExtensionDefinition;
  routes: ExtRoute[];
  runner: ExtensionRunner;
}

export interface ExtensionHost {
  /** Begin consuming the event log (call after the server is listening). */
  start(): void;
  stop(): void;
  /** Resolve once every runner has drained its queue (test helper). */
  idle(): Promise<void>;
  names(): string[];
}

/**
 * Boots the extensions enabled in config, in-process. Each is handed a
 * CoreClient (public API, attributed `ext:<name>`) and may register event
 * handlers + HTTP routes; nothing reaches into @tq/core directly, so an
 * extension is promotable to its own process unchanged (Q6/Q7).
 */
export function createExtensionHost(opts: ExtensionHostOptions): ExtensionHost {
  const { app, store, cfg, selfBaseUrl, available } = opts;
  const maxRetries = opts.maxRetries ?? 3;
  const baseLog = opts.log ?? ((m: string) => console.error(`[ext] ${m}`)); // eslint-disable-line no-console

  const extCfg = (cfg as { extensions?: Record<string, Record<string, unknown>> }).extensions ?? {};
  const loaded: LoadedExtension[] = [];

  for (const def of available) {
    const conf = extCfg[def.name] ?? {};
    if (conf.enabled !== true) continue;

    const regs: Registration[] = [];
    const routes: ExtRoute[] = [];
    const log = (msg: string, meta?: unknown) => baseLog(`${def.name}: ${msg}`, meta);

    const ctx: ExtensionContext = {
      name: def.name,
      core: createCoreClient({
        baseUrl: selfBaseUrl,
        fetch: opts.coreFetch,
        actor: `ext:${def.name}`,
      }),
      config: conf,
      log,
      on: (filter, handler) => regs.push({ filter, handler }),
      onAny: (handler) => regs.push({ filter: {}, handler }),
      route: (route) => routes.push(route),
    };

    // setup() only registers; actual core calls happen in handlers/routes.
    void def.setup(ctx);
    store.subscriptions.register(def.name);

    // Mount gateway routes under /api/ext/<name>.
    for (const route of routes) {
      app.route({
        method: route.method,
        url: `/api/ext/${def.name}${route.path}`,
        handler: async (req, reply) => {
          const extReq: ExtRequest = {
            method: req.method,
            path: route.path,
            params: (req.params as Record<string, string>) ?? {},
            query: (req.query as Record<string, string | undefined>) ?? {},
            headers: req.headers as Record<string, string | undefined>,
            body: req.body,
          };
          const res = await route.handler(extReq);
          if (res.headers) for (const [k, v] of Object.entries(res.headers)) reply.header(k, v);
          reply.code(res.status ?? 200);
          return res.body ?? null;
        },
      });
    }

    loaded.push({
      def,
      routes,
      runner: new ExtensionRunner(def.name, regs, store, maxRetries, log),
    });
  }

  // Discovery endpoint (Q7).
  app.get("/api/extensions", () => {
    const seq = store.events.maxSeq();
    return {
      extensions: loaded.map((l) => {
        const sub = store.subscriptions.get(l.def.name);
        return {
          name: l.def.name,
          routes: l.routes.map((r) => ({ method: r.method, path: `/api/ext/${l.def.name}${r.path}` })),
          events: {
            cursor: sub?.cursor ?? 0,
            lag: Math.max(0, seq - (sub?.cursor ?? 0)),
            dead_letters: sub?.dead_letters.length ?? 0,
            last_seen_at: sub?.last_seen_at ?? null,
          },
        };
      }),
    };
  });

  return {
    start: () => {
      for (const l of loaded) l.runner.start();
    },
    stop: () => {
      for (const l of loaded) l.runner.stop();
    },
    idle: async () => {
      for (;;) {
        if (!loaded.some((l) => l.runner.pending > 0)) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    names: () => loaded.map((l) => l.def.name),
  };
}
