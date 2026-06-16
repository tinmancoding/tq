import {
  defineExtension,
  type EventEnvelope,
  type ExtensionContext,
  type ExtensionDefinition,
  type ExtRequest,
} from "@tq/extension-sdk";
import type { CoreClient, Label, Task } from "@tq/contract";
import { type Embedder, taskEmbeddingText } from "./embedder.js";
import { SemanticStore } from "./store.js";

export interface SearchSemanticOptions {
  /** Pluggable embedder (HashEmbedder default; Titan opt-in). */
  embedder: Embedder;
  /** Path to the extension's OWN sqlite file (":memory:" in tests). */
  dbPath: string;
}

const RRF_K = 60;
const CANDIDATE_K = 25;

/**
 * @tq/ext-search-semantic — vector/hybrid search as a projection extension
 * (Phase H). It maintains its own vector index by consuming task events, and
 * serves GET /api/ext/search-semantic/search = RRF(core FTS, its vec). Core
 * keeps FTS as its always-on projection; this never touches @tq/core.
 */
export function searchSemanticExtension(opts: SearchSemanticOptions): ExtensionDefinition {
  return defineExtension({
    name: "search-semantic",
    setup: (ctx: ExtensionContext) => {
      const store = new SemanticStore(opts.dbPath, opts.embedder.dims);

      // Embed everything still queued (best-effort). A transient embed failure
      // (e.g. AWS down) leaves items queued; the next task event retries them.
      const drain = async (): Promise<void> => {
        for (const taskId of store.queued()) {
          let task: Task | null = null;
          try {
            task = await ctx.core.tasks.get(taskId);
          } catch {
            return; // core unreachable; try again later
          }
          if (!task) {
            store.dequeue(taskId); // task gone
            continue;
          }
          try {
            const vec = await opts.embedder.embed(taskEmbeddingText(task.title, task.body));
            store.upsert(taskId, vec);
            store.dequeue(taskId);
          } catch (err) {
            ctx.log(`embed failed for ${taskId}: ${err instanceof Error ? err.message : err}`);
            return; // leave queued; retry on a later event
          }
        }
      };

      ctx.on({ types: ["TaskCreated", "TaskUpdated"], scopeType: "task" }, async (ev) => {
        if (!ev.scope_id || !store.available) return;
        store.enqueue(ev.scope_id);
        await drain();
      });

      ctx.on({ types: ["TaskDeleted"], scopeType: "task" }, (ev: EventEnvelope) => {
        if (!ev.scope_id) return;
        store.remove(ev.scope_id);
        store.dequeue(ev.scope_id);
      });

      ctx.route({
        method: "GET",
        path: "/search",
        handler: (req) => runSearch(req, ctx.core, store, opts.embedder),
      });
    },
  });
}

async function runSearch(
  req: ExtRequest,
  core: CoreClient,
  store: SemanticStore,
  embedder: Embedder,
): Promise<{ body: { hits: { task: Task; score: number; signals: { fts: boolean; vector: boolean } }[]; vector: boolean } }> {
  const q = (req.query.q ?? "").toString();
  const status = req.query.status;
  const label = parseLabel(req.query.label);
  const limit = req.query.limit ? Number(req.query.limit) : 25;

  // FTS half from core (the always-on projection).
  const fts = await core.search(q, { status, label: req.query.label, limit: CANDIDATE_K });
  const ftsRank = new Map<string, number>();
  const taskById = new Map<string, Task>();
  fts.hits.forEach((h, i) => {
    ftsRank.set(h.task.id, i);
    taskById.set(h.task.id, h.task);
  });

  // Vector half from our own index (best-effort).
  const vecRank = new Map<string, number>();
  let vectorUsed = false;
  if (store.available && q.trim().length > 0) {
    try {
      const qv = await embedder.embed(q);
      store.search(qv, CANDIDATE_K).forEach((h, i) => vecRank.set(h.task_id, i));
      vectorUsed = true;
    } catch {
      vectorUsed = false;
    }
  }

  // Reciprocal Rank Fusion over the union of candidate ids.
  const ids = new Set<string>([...ftsRank.keys(), ...vecRank.keys()]);
  const scored = [...ids].map((id) => {
    const fr = ftsRank.get(id);
    const vr = vecRank.get(id);
    let score = 0;
    if (fr !== undefined) score += 1 / (RRF_K + fr + 1);
    if (vr !== undefined) score += 1 / (RRF_K + vr + 1);
    return { id, score, fts: fr !== undefined, vector: vr !== undefined };
  });
  scored.sort((a, b) => b.score - a.score);

  const hits: { task: Task; score: number; signals: { fts: boolean; vector: boolean } }[] = [];
  for (const s of scored) {
    let task = taskById.get(s.id);
    if (!task) {
      try {
        task = (await core.tasks.get(s.id)) as Task;
      } catch {
        continue;
      }
    }
    if (!task) continue;
    if (status && task.status !== status) continue;
    if (label && !task.labels.some((l) => l.key === label.key && l.value === label.value)) continue;
    hits.push({ task, score: s.score, signals: { fts: s.fts, vector: s.vector } });
    if (hits.length >= limit) break;
  }

  return { body: { hits, vector: vectorUsed } };
}

function parseLabel(s?: string): Label | null {
  if (!s) return null;
  const idx = s.indexOf(":");
  if (idx <= 0) return null;
  return { key: s.slice(0, idx), value: s.slice(idx + 1) };
}
