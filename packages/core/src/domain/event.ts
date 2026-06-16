import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import { newId, now } from "./ids.js";

export type EventScopeType = "task" | "intake" | "global";

export interface AppendEventInput {
  type: string;
  scopeType: EventScopeType;
  scopeId?: string | null;
  actor: string;
  payload?: unknown;
  correlationId?: string | null;
  schemaVersion?: number;
}

export interface EventRow {
  seq: number;
  stream_seq: number;
  id: string;
  type: string;
  scope_type: EventScopeType;
  scope_id: string | null;
  actor: string;
  payload: unknown;
  schema_version: number;
  correlation_id: string | null;
  created_at: string;
}

export interface ReadEventsOpts {
  /** Exclusive lower bound on global seq. */
  since?: number;
  types?: string[];
  scopeType?: string;
  scopeId?: string;
  limit?: number;
}

interface RawEventRow extends Omit<EventRow, "payload"> {
  payload: string;
}

/**
 * The append-only event log. `append` MUST be called inside an open
 * transaction so the event commits atomically with the state fold that the
 * caller performs in the same tx (Q1: transactional log + synchronous read
 * model). Single-writer better-sqlite3 makes both the global `seq`
 * (AUTOINCREMENT) and the per-entity `stream_seq` (MAX+1) race-free.
 */
export class EventStore {
  private readonly insertStmt: Database.Statement;
  private readonly streamSeqStmt: Database.Statement;
  /** Events appended in the current (possibly nested) transaction, flushed to
   *  the bus only after the outermost commit. */
  private pending: EventRow[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventBus,
  ) {
    this.streamSeqStmt = db.prepare(
      `SELECT COALESCE(MAX(stream_seq), 0) AS m FROM event WHERE scope_type = ? AND scope_id IS ?`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO event
         (stream_seq, id, type, scope_type, scope_id, actor, payload, schema_version, correlation_id, created_at)
       VALUES
         (@stream_seq, @id, @type, @scope_type, @scope_id, @actor, @payload, @schema_version, @correlation_id, @created_at)`,
    );
  }

  /**
   * Mirrors better-sqlite3's `db.transaction`: returns a function that runs `fn`
   * in a transaction and, on the OUTERMOST commit, flushes every event appended
   * during it to the bus as `@event` (carrying the persisted envelope incl.
   * `seq`). Nested calls (e.g. promote → tasks.create) buffer into the same
   * batch and flush once. A rollback discards the buffer (nothing emitted).
   */
  transaction<T>(fn: () => T): () => T {
    const run = this.db.transaction(fn);
    return (): T => {
      const top = !this.db.inTransaction;
      let result: T;
      try {
        result = run();
      } catch (err) {
        if (top) this.pending = [];
        throw err;
      }
      if (top && this.pending.length > 0) {
        const flush = this.pending;
        this.pending = [];
        for (const ev of flush) this.bus.emit("@event", ev);
      }
      return result;
    };
  }

  append(input: AppendEventInput): EventRow {
    const id = newId();
    const ts = now();
    const scopeId = input.scopeId ?? null;
    const schemaVersion = input.schemaVersion ?? 1;
    const streamSeq =
      (this.streamSeqStmt.get(input.scopeType, scopeId) as { m: number }).m + 1;
    const info = this.insertStmt.run({
      stream_seq: streamSeq,
      id,
      type: input.type,
      scope_type: input.scopeType,
      scope_id: scopeId,
      actor: input.actor,
      payload: JSON.stringify(input.payload ?? {}),
      schema_version: schemaVersion,
      correlation_id: input.correlationId ?? null,
      created_at: ts,
    });
    const row: EventRow = {
      seq: Number(info.lastInsertRowid),
      stream_seq: streamSeq,
      id,
      type: input.type,
      scope_type: input.scopeType,
      scope_id: scopeId,
      actor: input.actor,
      payload: input.payload ?? {},
      schema_version: schemaVersion,
      correlation_id: input.correlationId ?? null,
      created_at: ts,
    };
    this.pending.push(row);
    return row;
  }

  /** Read events in global `seq` order. Used by the SSE stream (Phase D). */
  read(opts: ReadEventsOpts = {}): EventRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.since !== undefined) {
      where.push(`seq > ?`);
      params.push(opts.since);
    }
    if (opts.scopeType) {
      where.push(`scope_type = ?`);
      params.push(opts.scopeType);
    }
    if (opts.scopeId) {
      where.push(`scope_id = ?`);
      params.push(opts.scopeId);
    }
    if (opts.types?.length) {
      where.push(`type IN (${opts.types.map(() => "?").join(", ")})`);
      params.push(...opts.types);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts.limit ?? 500;
    const rows = this.db
      .prepare(`SELECT * FROM event ${whereSql} ORDER BY seq ASC LIMIT ?`)
      .all(...params, limit) as RawEventRow[];
    return rows.map(hydrate);
  }

  get(seq: number): EventRow | null {
    const row = this.db.prepare(`SELECT * FROM event WHERE seq = ?`).get(seq) as
      | RawEventRow
      | undefined;
    return row ? hydrate(row) : null;
  }

  /** Per-entity history (contiguous 1..N for committed events). */
  forScope(scopeType: EventScopeType, scopeId: string): EventRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM event WHERE scope_type = ? AND scope_id = ? ORDER BY stream_seq ASC`,
      )
      .all(scopeType, scopeId) as RawEventRow[];
    return rows.map(hydrate);
  }

  /** Highest committed global seq (0 if empty). The as-of cursor for reads. */
  maxSeq(): number {
    return (
      this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM event`).get() as {
        m: number;
      }
    ).m;
  }
}

function hydrate(row: RawEventRow): EventRow {
  return { ...row, payload: row.payload ? JSON.parse(row.payload) : {} };
}
