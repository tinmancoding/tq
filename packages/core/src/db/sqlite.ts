import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import * as sqliteVec from "sqlite-vec";
import { runMigrations } from "./migrate.js";
import { markVecAvailable } from "../search/vector.js";

export type DB = Database.Database;

export interface OpenDbOptions {
  /** Absolute path to the sqlite file, or ":memory:" for tests. */
  path: string;
  /** Skip running migrations (rarely needed). */
  skipMigrations?: boolean;
  /** Embedding dimensions for the task_vec table (default 1024 = Titan V2). */
  embeddingDims?: number;
  /** Force-disable sqlite-vec (FTS-only mode). */
  disableVector?: boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Open (and migrate) a tq database. */
export function openDb(opts: OpenDbOptions): DB {
  if (opts.path !== ":memory:") {
    mkdirSync(dirname(opts.path), { recursive: true });
  }
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Best-effort load of sqlite-vec; the system degrades to FTS-only if absent.
  let vecOk = false;
  if (!opts.disableVector) {
    try {
      sqliteVec.load(db);
      db.prepare("SELECT vec_version()").get();
      vecOk = true;
    } catch {
      vecOk = false;
    }
  }

  if (!opts.skipMigrations) {
    runMigrations(db, join(__dirname, "migrations"));
  }

  if (vecOk) {
    const dims = opts.embeddingDims ?? 1024;
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS task_vec USING vec0(
         task_id TEXT PRIMARY KEY,
         embedding FLOAT[${dims}]
       );`,
    );
  }
  markVecAvailable(db, vecOk);

  return db;
}
