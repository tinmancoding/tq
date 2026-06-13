import type Database from "better-sqlite3";
import type { TaskRepo } from "../domain/task.js";
import type { Label, Task } from "../domain/types.js";
import { ftsSearch } from "./fts.js";
import { isVecAvailable, vecSearch } from "./vector.js";
import type { Embedder } from "./embeddings.js";

export interface SearchHit {
  task: Task;
  score: number;
  signals: { fts: boolean; vector: boolean };
}

export interface SearchResult {
  hits: SearchHit[];
  vector: boolean; // whether the vector signal contributed
}

export interface SearchOpts {
  status?: Task["status"];
  label?: Label;
  limit?: number;
}

const RRF_K = 60;
const CANDIDATE_K = 25;

/**
 * Hybrid search: FTS5 (BM25) ∪ sqlite-vec KNN, fused with Reciprocal Rank
 * Fusion. Falls back to FTS-only when vectors are unavailable or embedding the
 * query fails (AWS down); the `vector` flag reports which signals were used.
 */
export async function search(
  db: Database.Database,
  tasks: TaskRepo,
  query: string,
  opts: SearchOpts = {},
  embedder?: Embedder,
): Promise<SearchResult> {
  const limit = opts.limit ?? 25;

  const ftsHits = ftsSearch(db, query, CANDIDATE_K);
  const ftsRank = new Map<string, number>();
  ftsHits.forEach((h, i) => ftsRank.set(h.task_id, i));

  // Vector signal (best-effort).
  let vectorUsed = false;
  const vecRank = new Map<string, number>();
  if (embedder && isVecAvailable(db) && query.trim().length > 0) {
    try {
      const qv = await embedder.embed(query);
      const vecHits = vecSearch(db, qv, CANDIDATE_K);
      vecHits.forEach((h, i) => vecRank.set(h.task_id, i));
      vectorUsed = true;
    } catch {
      vectorUsed = false;
    }
  }

  // Reciprocal Rank Fusion over the union of candidate ids.
  const ids = new Set<string>([...ftsRank.keys(), ...vecRank.keys()]);
  const scored: { id: string; score: number; fts: boolean; vector: boolean }[] = [];
  for (const id of ids) {
    const fr = ftsRank.get(id);
    const vr = vecRank.get(id);
    let score = 0;
    if (fr !== undefined) score += 1 / (RRF_K + fr + 1);
    if (vr !== undefined) score += 1 / (RRF_K + vr + 1);
    scored.push({ id, score, fts: fr !== undefined, vector: vr !== undefined });
  }
  scored.sort((a, b) => b.score - a.score);

  const hits: SearchHit[] = [];
  for (const s of scored) {
    const task = tasks.get(s.id);
    if (!task) continue;
    if (opts.status && task.status !== opts.status) continue;
    if (
      opts.label &&
      !task.labels.some((l) => l.key === opts.label!.key && l.value === opts.label!.value)
    ) {
      continue;
    }
    hits.push({ task, score: s.score, signals: { fts: s.fts, vector: s.vector } });
    if (hits.length >= limit) break;
  }

  return { hits, vector: vectorUsed };
}
