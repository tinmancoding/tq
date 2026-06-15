import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { runMigrations } from "./migrate.js";

export type DB = Database.Database;

export interface OpenDbOptions {
  /** Absolute path to the sqlite file, or ":memory:" for tests. */
  path: string;
  /** Skip running migrations (rarely needed). */
  skipMigrations?: boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Open (and migrate) a tq database. Core is FTS-only; the vector index lives
 *  in the @tq/ext-search-semantic extension's own store. */
export function openDb(opts: OpenDbOptions): DB {
  if (opts.path !== ":memory:") {
    mkdirSync(dirname(opts.path), { recursive: true });
  }
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  if (!opts.skipMigrations) {
    runMigrations(db, join(__dirname, "migrations"));
  }

  return db;
}
