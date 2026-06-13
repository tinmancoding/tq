import type Database from "better-sqlite3";
import type { Label } from "../domain/types.js";

/** Flatten labels into a searchable string: "key:value key:value". */
export function labelsText(labels: Label[]): string {
  return labels.map((l) => `${l.key}:${l.value}`).join(" ");
}

/** Upsert a task's row in the FTS index. */
export function indexTask(
  db: Database.Database,
  task: { id: string; title: string; body: string | null; labels: Label[] },
): void {
  db.prepare(`DELETE FROM task_fts WHERE task_id = ?`).run(task.id);
  db.prepare(
    `INSERT INTO task_fts (task_id, title, body, labels_text) VALUES (?, ?, ?, ?)`,
  ).run(task.id, task.title, task.body ?? "", labelsText(task.labels));
}

export function removeFromIndex(db: Database.Database, taskId: string): void {
  db.prepare(`DELETE FROM task_fts WHERE task_id = ?`).run(taskId);
}

export interface FtsHit {
  task_id: string;
  rank: number; // bm25: lower is better
}

/**
 * FTS5 keyword search returning task ids ranked by bm25.
 * The query is sanitized into a safe MATCH expression (prefix-OR of terms).
 */
export function ftsSearch(db: Database.Database, query: string, limit = 25): FtsHit[] {
  const match = toMatchExpr(query);
  if (!match) return [];
  const rows = db
    .prepare(
      `SELECT task_id, bm25(task_fts) AS rank
         FROM task_fts
        WHERE task_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, limit) as { task_id: string; rank: number }[];
  return rows;
}

/**
 * Build a safe FTS5 MATCH expression from free user input. Each alphanumeric
 * token becomes a prefix term; tokens are OR-ed so partial matches surface.
 */
export function toMatchExpr(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}
