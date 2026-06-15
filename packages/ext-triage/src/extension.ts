import {
  defineExtension,
  type EventEnvelope,
  type ExtensionContext,
  type ExtensionDefinition,
} from "@tq/extension-sdk";
import type { CoreClient } from "@tq/contract";
import { decideGate } from "./gate.js";
import type { TriageEngine, TriageImage, TriageSearchHit } from "./engine.js";

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
    const result = await opts.engine.triage(
      { intake, images },
      (q, limit) => searchTasks(ctx.core, q, limit),
      (t) => {
        trace = t;
      },
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

async function searchTasks(
  core: CoreClient,
  query: string,
  limit: number,
): Promise<TriageSearchHit[]> {
  const res = await core.search(query, { limit });
  return res.hits.map((h) => ({
    id: h.task.id,
    title: h.task.title,
    snippet: (h.task.body ?? "").slice(0, 200),
    labels: h.task.labels,
    status: h.task.status,
    score: h.score,
  }));
}
