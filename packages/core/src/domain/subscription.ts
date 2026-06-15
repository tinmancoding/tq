import type Database from "better-sqlite3";
import { now } from "./ids.js";

export interface SubscriptionFilters {
  types?: string[];
  scopeType?: string;
}

export interface DeadLetter {
  seq: number;
  error: string;
  at: string;
}

export interface Subscription {
  consumer_id: string;
  cursor: number;
  filters: SubscriptionFilters | null;
  last_seen_at: string | null;
  dead_letters: DeadLetter[];
  created_at: string;
}

interface SubscriptionRow {
  consumer_id: string;
  cursor: number;
  filters: string | null;
  last_seen_at: string | null;
  dead_letters: string;
  created_at: string;
}

/**
 * Server-side durable subscriptions (Q5b). A consumer registers an id, commits
 * its cursor as it processes the log, and records dead-letters for events it
 * gave up on. Lag = maxSeq - cursor. This is the generalization of the old
 * `triage_job` queue into a reusable mechanism.
 */
export class SubscriptionRepo {
  constructor(private readonly db: Database.Database) {}

  /** Idempotently register a consumer; returns the (existing or new) row. */
  register(consumerId: string, filters?: SubscriptionFilters): Subscription {
    const existing = this.get(consumerId);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO subscription (consumer_id, cursor, filters, last_seen_at, dead_letters, created_at)
         VALUES (?, 0, ?, NULL, '[]', ?)`,
      )
      .run(consumerId, filters ? JSON.stringify(filters) : null, now());
    return this.get(consumerId)!;
  }

  get(consumerId: string): Subscription | null {
    const row = this.db
      .prepare(`SELECT * FROM subscription WHERE consumer_id = ?`)
      .get(consumerId) as SubscriptionRow | undefined;
    return row ? hydrate(row) : null;
  }

  list(): Subscription[] {
    return (this.db.prepare(`SELECT * FROM subscription ORDER BY consumer_id`).all() as SubscriptionRow[]).map(
      hydrate,
    );
  }

  /** Advance the committed cursor (only forward) and bump last_seen_at. */
  commit(consumerId: string, cursor: number): void {
    this.db
      .prepare(
        `UPDATE subscription SET cursor = MAX(cursor, ?), last_seen_at = ? WHERE consumer_id = ?`,
      )
      .run(cursor, now(), consumerId);
  }

  recordDeadLetter(consumerId: string, seq: number, error: string): void {
    const sub = this.get(consumerId);
    if (!sub) return;
    const next = [...sub.dead_letters, { seq, error, at: now() }].slice(-100);
    this.db
      .prepare(`UPDATE subscription SET dead_letters = ? WHERE consumer_id = ?`)
      .run(JSON.stringify(next), consumerId);
  }

  /** How far behind the head a consumer is. */
  lag(consumerId: string, maxSeq: number): number {
    const sub = this.get(consumerId);
    return sub ? Math.max(0, maxSeq - sub.cursor) : maxSeq;
  }
}

function hydrate(row: SubscriptionRow): Subscription {
  return {
    ...row,
    filters: row.filters ? JSON.parse(row.filters) : null,
    dead_letters: row.dead_letters ? JSON.parse(row.dead_letters) : [],
  };
}
