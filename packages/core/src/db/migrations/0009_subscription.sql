-- Phase D: durable subscription registry. Server-tracked cursors let consumers
-- (extensions) resume after downtime and make lag/dead-letters observable.
-- The event log itself is the source of truth; this is bookkeeping over it.

CREATE TABLE subscription (
  consumer_id  TEXT PRIMARY KEY,
  cursor       INTEGER NOT NULL DEFAULT 0,   -- last global seq the consumer has committed
  filters      TEXT,                         -- JSON: { types?: string[], scopeType?: string }
  last_seen_at TEXT,
  dead_letters TEXT NOT NULL DEFAULT '[]',    -- JSON array of { seq, error, at }
  created_at   TEXT NOT NULL
);
