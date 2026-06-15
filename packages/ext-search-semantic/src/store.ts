import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import * as sqliteVec from "sqlite-vec";

export interface VecHit {
  task_id: string;
  distance: number; // lower is closer
}

/**
 * The semantic-search extension's OWN store — a separate sqlite file with
 * sqlite-vec loaded. Core never touches it. Holds the vector index plus a
 * durable embedding queue (so a transient embed failure doesn't lose work and
 * isn't tied to the event cursor). Rebuildable from scratch by replaying the
 * task event stream from seq 0.
 */
export class SemanticStore {
  readonly db: Database.Database;
  private readonly vecOk: boolean;

  constructor(path: string, dims: number) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    let ok = false;
    try {
      sqliteVec.load(this.db);
      this.db.prepare("SELECT vec_version()").get();
      ok = true;
    } catch {
      ok = false;
    }
    this.vecOk = ok;

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS embedding_queue (
         task_id TEXT PRIMARY KEY,
         enqueued_at TEXT NOT NULL
       )`,
    );
    if (ok) {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS task_vec USING vec0(
           task_id TEXT PRIMARY KEY,
           embedding FLOAT[${dims}]
         )`,
      );
    }
  }

  /** Whether the vector index is usable (sqlite-vec loaded). */
  get available(): boolean {
    return this.vecOk;
  }

  enqueue(taskId: string): void {
    this.db
      .prepare(
        `INSERT INTO embedding_queue (task_id, enqueued_at) VALUES (?, ?)
         ON CONFLICT(task_id) DO UPDATE SET enqueued_at = excluded.enqueued_at`,
      )
      .run(taskId, new Date().toISOString());
  }

  dequeue(taskId: string): void {
    this.db.prepare(`DELETE FROM embedding_queue WHERE task_id = ?`).run(taskId);
  }

  queued(limit = 1000): string[] {
    return (
      this.db
        .prepare(`SELECT task_id FROM embedding_queue ORDER BY enqueued_at LIMIT ?`)
        .all(limit) as { task_id: string }[]
    ).map((r) => r.task_id);
  }

  pending(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM embedding_queue`).get() as { n: number }).n;
  }

  upsert(taskId: string, embedding: number[]): void {
    if (!this.vecOk) return;
    const vec = new Float32Array(embedding);
    this.db.prepare(`DELETE FROM task_vec WHERE task_id = ?`).run(taskId);
    this.db.prepare(`INSERT INTO task_vec (task_id, embedding) VALUES (?, ?)`).run(taskId, vec);
  }

  remove(taskId: string): void {
    if (this.vecOk) this.db.prepare(`DELETE FROM task_vec WHERE task_id = ?`).run(taskId);
  }

  search(queryEmbedding: number[], limit = 25): VecHit[] {
    if (!this.vecOk) return [];
    const vec = new Float32Array(queryEmbedding);
    return this.db
      .prepare(
        `SELECT task_id, distance FROM task_vec
          WHERE embedding MATCH ? AND k = ?
          ORDER BY distance`,
      )
      .all(vec, limit) as VecHit[];
  }

  close(): void {
    this.db.close();
  }
}
