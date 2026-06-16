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
  vector: boolean;
}

export interface SearchOpts {
  status?: Task["status"];
  label?: Label;
  limit?: number;
}

const RRF_K = 60;
const CANDIDATE_K = 25;

/**
 * Core keyword search: FTS5 (BM25) only. This is core's always-on search
 * projection (the FTS index is maintained in-transaction on every task write).
 * Semantic/hybrid search lives in the @tq/ext-search-semantic extension, which
 * fuses these results with its own vector index.
 */
export function ftsSearchTasks(
  db: Database.Database,
  tasks: TaskRepo,
  query: string,
  opts: SearchOpts = {},
): SearchResult {
  const limit = opts.limit ?? 25;
  const ftsHits = ftsSearch(db, query, CANDIDATE_K);
  const hits: SearchHit[] = [];
  ftsHits.forEach((h, i) => {
    if (hits.length >= limit) return;
    const task = tasks.get(h.task_id);
    if (!task) return;
    if (opts.status && task.status !== opts.status) return;
    if (
      opts.label &&
      !task.labels.some((l) => l.key === opts.label!.key && l.value === opts.label!.value)
    ) {
      return;
    }
    hits.push({ task, score: 1 / (RRF_K + i + 1), signals: { fts: true, vector: false } });
  });
  return { hits, vector: false };
}
