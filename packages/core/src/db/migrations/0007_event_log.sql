-- Phase B: the append-only event log (the durable spine).
-- Every state mutation appends an immutable event here, inside the same
-- transaction that folds current-state tables (see docs/event-driven-*.md Q1/Q4).
-- Dual sequence: global `seq` (pub/sub cursor + total order) and per-entity
-- `stream_seq` (1..N within a scope, for gap-detection + optimistic concurrency).

CREATE TABLE event (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_seq     INTEGER NOT NULL,
  id             TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,                  -- PascalCase past-tense, e.g. 'TaskMoved'
  scope_type     TEXT NOT NULL,                  -- 'task' | 'intake' | 'global'
  scope_id       TEXT,                           -- aggregate id (NULL for 'global')
  actor          TEXT NOT NULL,
  payload        TEXT NOT NULL,                  -- JSON: inline value OR {"$ref":"blob:sha256:…"}
  schema_version INTEGER NOT NULL DEFAULT 1,
  correlation_id TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_event_stream ON event(scope_type, scope_id, stream_seq);
CREATE INDEX idx_event_seq ON event(seq);
