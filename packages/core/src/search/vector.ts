import type Database from "better-sqlite3";

/** Tracks whether sqlite-vec is loaded for a given connection. */
const vecAvailable = new WeakMap<Database.Database, boolean>();

export function markVecAvailable(db: Database.Database, available: boolean): void {
  vecAvailable.set(db, available);
}

export function isVecAvailable(db: Database.Database): boolean {
  return vecAvailable.get(db) ?? false;
}

/** Upsert a task's embedding into the vector index (no-op if vec unavailable). */
export function upsertTaskVector(
  db: Database.Database,
  taskId: string,
  embedding: number[],
): void {
  if (!isVecAvailable(db)) return;
  const vec = new Float32Array(embedding);
  db.prepare(`DELETE FROM task_vec WHERE task_id = ?`).run(taskId);
  db.prepare(`INSERT INTO task_vec (task_id, embedding) VALUES (?, ?)`).run(taskId, vec);
}

export function removeTaskVector(db: Database.Database, taskId: string): void {
  if (!isVecAvailable(db)) return;
  db.prepare(`DELETE FROM task_vec WHERE task_id = ?`).run(taskId);
}

export interface VecHit {
  task_id: string;
  distance: number; // lower is closer
}

/** KNN search over task_vec for the given query embedding. */
export function vecSearch(
  db: Database.Database,
  queryEmbedding: number[],
  limit = 25,
): VecHit[] {
  if (!isVecAvailable(db)) return [];
  const vec = new Float32Array(queryEmbedding);
  return db
    .prepare(
      `SELECT task_id, distance
         FROM task_vec
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance`,
    )
    .all(vec, limit) as VecHit[];
}
