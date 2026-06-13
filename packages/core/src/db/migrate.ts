import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Applies all *.sql files in `migrationsDir` (lexical order) that have not yet
 * been recorded in the `_migrations` table. Each migration runs in a
 * transaction. Idempotent: already-applied migrations are skipped.
 */
export function runMigrations(db: Database.Database, migrationsDir: string): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name       TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     );`,
  );

  const applied = new Set<string>(
    db.prepare(`SELECT name FROM _migrations`).all().map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const record = db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`);

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    });
    tx();
  }
}
