import type { CoreClient } from "@tq/contract";

/**
 * @tq/extension-sdk — the contract an extension is written against.
 *
 * An extension is a subscriber that touches core ONLY through the public API:
 * the event log (in), the REST surface + context store (out). It never imports
 * @tq/core. That is what makes an extension hostable in-process today and
 * promotable to a separate process tomorrow with no code change (Q6).
 */

/** A persisted event as delivered to extensions (mirrors the core envelope). */
export interface EventEnvelope {
  seq: number;
  stream_seq: number;
  id: string;
  type: string;
  scope_type: "task" | "intake" | "global";
  scope_id: string | null;
  actor: string;
  payload: unknown;
  schema_version: number;
  correlation_id: string | null;
  created_at: string;
}

export interface EventFilter {
  /** Only deliver these event types (e.g. ["IntakeCaptured"]). */
  types?: string[];
  /** Only deliver events for this scope. */
  scopeType?: "task" | "intake" | "global";
}

export type EventHandler = (ev: EventEnvelope) => void | Promise<void>;

/** A framework-agnostic HTTP request handed to an extension route. */
export interface ExtRequest {
  method: string;
  /** Path *after* the /api/ext/<name> prefix, e.g. "/stats". */
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface ExtResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type ExtRouteHandler = (req: ExtRequest) => ExtResponse | Promise<ExtResponse>;

export interface ExtRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Mounted at /api/ext/<name><path>. Supports Fastify-style ":params". */
  path: string;
  handler: ExtRouteHandler;
}

/** The handle passed to an extension's `setup`, used to register behavior. */
export interface ExtensionContext {
  /** This extension's name (also its subscription/consumer id + route prefix). */
  readonly name: string;
  /** Typed public-API client, attributed as `ext:<name>`. */
  readonly core: CoreClient;
  /** Per-extension config block from `[extensions.<name>]`. */
  readonly config: Record<string, unknown>;
  /** Structured log line, namespaced to the extension. */
  log(message: string, meta?: unknown): void;
  /** Subscribe to events. May be called multiple times with different filters. */
  on(filter: EventFilter, handler: EventHandler): void;
  /** Convenience: subscribe to all events. */
  onAny(handler: EventHandler): void;
  /** Register an HTTP route under the extension's gateway prefix. */
  route(route: ExtRoute): void;
}

export interface ExtensionDefinition {
  /** Stable identifier: subscription id, config key, and /api/ext/<name> prefix. */
  name: string;
  /** Called once at host startup to register event handlers and routes. */
  setup: (ctx: ExtensionContext) => void | Promise<void>;
}

/** Identity helper that pins the definition's type. */
export function defineExtension(def: ExtensionDefinition): ExtensionDefinition {
  return def;
}

export type { CoreClient } from "@tq/contract";
