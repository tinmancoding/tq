import type Database from "better-sqlite3";
import type { TaskRepo } from "../domain/task.js";
import type { Label, Task } from "../domain/types.js";
import { ftsSearch } from "./fts.js";

export interface SearchHit {
  task: Task;
  score: number;
  signals: { fts: boolean; vector: boolean };
}

export interface SearchResult {
  hits: SearchHit[];
  vector: boolean; // whether vector signal was available
}

export interface SearchOpts {
  status?: Task["status"];
  label?: Label;
  limit?: number;
}

/**
 * Hybrid search. Phase 1 is FTS-only; vector/RRF fusion lands in Phase 2 and
 * will merge a sqlite-vec KNN list here. The `vector` flag tells clients which
 * signals were available so the UI can hint at degradation.
 */
export function search(
  db: Database.Database,
  tasks: TaskRepo,
  query: string,
  opts: SearchOpts = {},
): SearchResult {
  const limit = opts.limit ?? 25;
  const ftsHits = ftsSearch(db, query, Math.max(limit * 2, 25));

  const hits: SearchHit[] = [];
  for (const h of ftsHits) {
    const task = tasks.get(h.task_id);
    if (!task) continue;
    if (opts.status && task.status !== opts.status) continue;
    if (opts.label && !task.labels.some((l) => l.key === opts.label!.key && l.value === opts.label!.value)) {
      continue;
    }
    // bm25 rank: lower is better → convert to a descending score.
    hits.push({ task, score: 1 / (1 + h.rank), signals: { fts: true, vector: false } });
    if (hits.length >= limit) break;
  }

  return { hits, vector: false };
}
