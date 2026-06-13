import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "./ids.js";

export interface AttachmentMeta {
  sha256: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface IntakeAttachment extends AttachmentMeta {
  filename: string | null;
  ord: number;
}

/**
 * Content-addressed blob store. Files live at <dir>/<sha256>; the DB holds
 * metadata and the intake⇄attachment links. Identical bytes dedupe to one file.
 */
export class AttachmentRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly dir: string,
  ) {
    mkdirSync(this.dir, { recursive: true });
  }

  filePath(sha256: string): string {
    return join(this.dir, sha256);
  }

  /** Store bytes (idempotent by content) and return the sha256 address. */
  store(data: Buffer, opts: { mime: string; width?: number; height?: number }): string {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const path = this.filePath(sha256);
    if (!existsSync(path)) writeFileSync(path, data);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO attachment (sha256, mime, bytes, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256, opts.mime, data.byteLength, opts.width ?? null, opts.height ?? null, now());
    return sha256;
  }

  /** Link an attachment to an intake at a given ordinal. */
  link(intakeId: string, sha256: string, filename: string | null, ord: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO intake_attachment (intake_id, sha256, filename, ord)
         VALUES (?, ?, ?, ?)`,
      )
      .run(intakeId, sha256, filename, ord);
  }

  meta(sha256: string): AttachmentMeta | null {
    return (
      (this.db.prepare(`SELECT * FROM attachment WHERE sha256 = ?`).get(sha256) as AttachmentMeta) ??
      null
    );
  }

  forIntake(intakeId: string): IntakeAttachment[] {
    return this.db
      .prepare(
        `SELECT a.*, ia.filename, ia.ord
           FROM intake_attachment ia
           JOIN attachment a ON a.sha256 = ia.sha256
          WHERE ia.intake_id = ?
          ORDER BY ia.ord`,
      )
      .all(intakeId) as IntakeAttachment[];
  }

  readBase64(sha256: string): string | null {
    const path = this.filePath(sha256);
    if (!existsSync(path)) return null;
    return readFileSync(path).toString("base64");
  }
}
