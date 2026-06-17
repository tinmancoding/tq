import {
  defineExtension,
  type EventEnvelope,
  type ExtensionContext,
  type ExtensionDefinition,
} from "@tq/extension-sdk";
import type { CoreClient } from "@tq/contract";
import { decideGate } from "./gate.js";
import type {
  AttachmentResult,
  AtlassianClosures,
  TriageEngine,
  TriageImage,
  TriageInjected,
  TriageSearchHit,
} from "./engine.js";

export interface TriageExtensionOptions {
  /** The LLM engine (constructed by the host with AWS/pi access). */
  engine: TriageEngine;
  /** Auto-create confidence threshold (gate). */
  autoCreateConfidence: number;
  /**
   * Loads + prepares image attachments for an intake. Injected by the host
   * (which has filesystem access to the blob store); the extension stays
   * transport-agnostic.
   */
  loadImages?: (intakeId: string) => TriageImage[] | Promise<TriageImage[]>;
  /**
   * Per-pass wall-clock timeout in ms (default 180 000).
   * When the timeout fires the triage call is rejected and the existing
   * catch/failure path runs (trace+error persisted, intake left 'new').
   * Inject a small value in tests (e.g. 50) to exercise the abort path.
   */
  passTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Wall-clock bound helper
// ---------------------------------------------------------------------------

/**
 * Race `promise` against a timeout that rejects after `ms` milliseconds.
 * Clears the timer if the promise resolves/rejects first.
 */
function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`triage pass timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timerId);
  });
}

/**
 * The triage extension (Phase G — the proof). Reacts to IntakeCaptured /
 * IntakeRetriaged, runs the LLM triage pass, writes the result into
 * `context.triage` via the PUBLIC API, and applies the gate by calling
 * promote / link / markTriaged. It never touches @tq/core.
 */
export function triageExtension(opts: TriageExtensionOptions): ExtensionDefinition {
  return defineExtension({
    name: "triage",
    setup: (ctx: ExtensionContext) => {
      ctx.on({ types: ["IntakeCaptured", "IntakeRetriaged"], scopeType: "intake" }, (ev) =>
        handleIntake(ev, ctx, opts),
      );
    },
  });
}

async function handleIntake(
  ev: EventEnvelope,
  ctx: ExtensionContext,
  opts: TriageExtensionOptions,
): Promise<void> {
  const id = ev.scope_id;
  if (!id) return;

  const intake = await ctx.core.intake.get(id);
  // Idempotency guard: only triage intakes still awaiting it. A redelivered or
  // already-handled event is a no-op (at-least-once delivery, Q5).
  if (!intake || intake.status !== "new") return;

  let trace: unknown[] = [];
  try {
    const images = (await opts.loadImages?.(id)) ?? [];

    // Probe the Atlassian connector (design §3.1). If the health check fails
    // (404, network error, etc.) the connector is disabled for this pass.
    const atlassianEnabled = await probeAtlassian(ctx.core);

    // Build injected closures for the engine (design §3.1).
    const atlassian: AtlassianClosures | undefined = atlassianEnabled
      ? buildAtlassianClosures(ctx.core)
      : undefined;

    const injected: TriageInjected = {
      searchTasks: (q, limit) => searchTasks(ctx.core, q, limit),
      atlassianEnabled,
      atlassian,
    };

    // Per-pass wall-clock bound (Q12). When the timeout fires the rejection is
    // caught by the outer catch block, which persists trace+error and leaves
    // the intake 'new' so a manual retriage re-runs it.
    const passTimeoutMs = opts.passTimeoutMs ?? 180_000;
    const result = await runWithTimeout(
      opts.engine.triage(
        { intake, images },
        injected,
        (t) => {
          trace = t;
        },
      ),
      passTimeoutMs,
    );

    await ctx.core.context.set("intake", id, "triage", result);
    if (trace.length > 0) await ctx.core.context.set("intake", id, "triage_trace", trace);

    const action = decideGate(result, opts.autoCreateConfidence);
    switch (action.kind) {
      case "auto_create":
        await ctx.core.intake.promote(id, {});
        break;
      case "auto_link":
        try {
          await ctx.core.intake.link(id, action.task_id, "linked");
        } catch {
          // Candidate vanished — fall back to manual review.
          await ctx.core.intake.markTriaged(id);
        }
        break;
      case "review":
        await ctx.core.intake.markTriaged(id);
        break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`triage failed for ${id}: ${msg}`);
    // Persist the transcript + error for debugging, then leave the intake `new`
    // so a manual retriage re-runs it. (The event model has no per-item backoff
    // queue; throwing here would dead-letter and never auto-retry.)
    if (trace.length > 0) await ctx.core.context.set("intake", id, "triage_trace", trace).catch(() => {});
    await ctx.core.context.set("intake", id, "triage_error", msg).catch(() => {});
  }
}

/**
 * Probe the Atlassian connector by calling GET /ext/atlassian/health.
 * Returns true if the connector is reachable; false if absent or erroring.
 */
async function probeAtlassian(core: CoreClient): Promise<boolean> {
  try {
    await core.request("GET", "/ext/atlassian/health");
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the 5 Atlassian closures, each calling /ext/atlassian/* and returning
 * clean error text (never throwing) on failure (design §3.1).
 */
export function buildAtlassianClosures(core: CoreClient): AtlassianClosures {
  async function atlGet(path: string, toolName: string): Promise<unknown> {
    try {
      return await core.request("GET", path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[${toolName} error] ${msg}`;
    }
  }

  return {
    async jira_get(ref: string, include?: string[]): Promise<unknown> {
      const q = new URLSearchParams();
      if (include && include.length > 0) q.set("include", include.join(","));
      const qs = q.toString();
      return atlGet(`/ext/atlassian/jira/${encodeURIComponent(ref)}${qs ? `?${qs}` : ""}`, "jira_get");
    },

    async jira_search(jql: string, limit: number): Promise<unknown> {
      const params = `jql=${encodeURIComponent(jql)}&limit=${limit}`;
      return atlGet(`/ext/atlassian/jira/search?${params}`, "jira_search");
    },

    async confluence_get(ref: string, include?: string[]): Promise<unknown> {
      const q = new URLSearchParams();
      if (include && include.length > 0) q.set("include", include.join(","));
      const qs = q.toString();
      return atlGet(`/ext/atlassian/confluence/${encodeURIComponent(ref)}${qs ? `?${qs}` : ""}`, "confluence_get");
    },

    async confluence_search(cql: string, limit: number): Promise<unknown> {
      const params = `cql=${encodeURIComponent(cql)}&limit=${limit}`;
      return atlGet(`/ext/atlassian/confluence/search?${params}`, "confluence_search");
    },

    async fetch_attachment(ref: string, mimeHint: string): Promise<AttachmentResult | string> {
      const q = new URLSearchParams({ ref });
      if (mimeHint) q.set("mimeHint", mimeHint);
      try {
        return await core.request<AttachmentResult>("GET", `/ext/atlassian/attachment?${q.toString()}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[fetch_attachment error] ${msg}`;
      }
    },
  };
}

async function searchTasks(
  core: CoreClient,
  query: string,
  limit: number,
): Promise<TriageSearchHit[]> {
  // Prefer the semantic-search extension's hybrid endpoint (cross-extension call
  // via the public gateway); fall back to core FTS if it isn't hosted.
  let res: { hits: { task: { id: string; title: string; body: string | null; labels: { key: string; value: string }[]; status: string }; score: number }[] };
  try {
    res = await core.request(
      "GET",
      `/ext/search-semantic/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  } catch {
    res = await core.search(query, { limit });
  }
  return res.hits.map((h) => ({
    id: h.task.id,
    title: h.task.title,
    snippet: (h.task.body ?? "").slice(0, 200),
    labels: h.task.labels,
    status: h.task.status,
    score: h.score,
  }));
}
