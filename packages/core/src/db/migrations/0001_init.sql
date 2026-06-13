-- tq base schema (Phase 0/1). Vector table (task_vec) is added in a later
-- migration once the sqlite-vec extension is wired up (Phase 2).

PRAGMA foreign_keys = ON;

-- ─────────────────────────────── INTAKE ───────────────────────────────
CREATE TABLE intake (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'new',        -- new|triaged|promoted|discarded
  source        TEXT NOT NULL DEFAULT 'manual',     -- manual|github|confluence|jira|...
  source_ref    TEXT,
  event_sig     TEXT,
  body          TEXT,
  action_verbs  TEXT,                               -- JSON array
  discard_reason TEXT,
  triage        TEXT,                               -- JSON: TriageResult
  triage_error  TEXT,
  labels        TEXT,                               -- JSON k/v applied at capture
  watchlist_id  TEXT REFERENCES watchlist(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  triaged_at    TEXT,
  UNIQUE(source, event_sig)
);
CREATE INDEX idx_intake_status ON intake(status);
CREATE INDEX idx_intake_created ON intake(created_at);

-- ─────────────────────────────── TASK ─────────────────────────────────
CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'backlog',    -- backlog|next|doing|blocked|done|dropped
  priority      TEXT,                               -- high|med|low
  due_at        TEXT,
  snooze_until  TEXT,
  board_rank    TEXT,
  created_by    TEXT NOT NULL DEFAULT 'human:laci',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  done_at       TEXT
);
CREATE INDEX idx_task_status ON task(status);
CREATE INDEX idx_task_snooze ON task(snooze_until);

CREATE TABLE task_label (
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (task_id, key, value)
);
CREATE INDEX idx_label_kv ON task_label(key, value);

CREATE TABLE task_ref (
  id       TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  url      TEXT NOT NULL,
  external_id TEXT,
  title    TEXT,
  meta     TEXT
);
CREATE INDEX idx_ref_task ON task_ref(task_id);

CREATE TABLE intake_task (
  intake_id TEXT NOT NULL REFERENCES intake(id) ON DELETE CASCADE,
  task_id   TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  relation  TEXT NOT NULL DEFAULT 'source',
  created_at TEXT NOT NULL,
  PRIMARY KEY (intake_id, task_id)
);

-- ─────────────────────── ACTIVITY ─────────────────────────────────────
CREATE TABLE activity (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL,                         -- worklog|comment|system
  actor      TEXT NOT NULL,
  body       TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_task ON activity(task_id, created_at);

-- ─────────────────────────────── ATTACHMENTS ──────────────────────────
CREATE TABLE attachment (
  sha256     TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE intake_attachment (
  intake_id TEXT NOT NULL REFERENCES intake(id) ON DELETE CASCADE,
  sha256    TEXT NOT NULL REFERENCES attachment(sha256),
  filename  TEXT,
  ord       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (intake_id, sha256)
);

-- ─────────────────────────────── TRIAGE JOBS ──────────────────────────
CREATE TABLE triage_job (
  id          TEXT PRIMARY KEY,
  intake_id   TEXT NOT NULL REFERENCES intake(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'queued',       -- queued|running|done|error
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error  TEXT,
  next_run_at TEXT,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_job_status ON triage_job(status, next_run_at);

-- ─────────────────────────────── WATCHLISTS ───────────────────────────
CREATE TABLE watchlist (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  connector     TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  config        TEXT NOT NULL,
  default_labels TEXT,
  poll_interval_sec INTEGER NOT NULL DEFAULT 600,
  cursor        TEXT,
  secret_ref    TEXT,
  last_polled_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

-- ─────────────────────────────── TOKENS ───────────────────────────────
CREATE TABLE token (
  token   TEXT PRIMARY KEY,
  actor   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ─────────────────────────────── FTS5 ─────────────────────────────────
-- content='' (contentless): app supplies rowid = task rowid mapping via a
-- mapping column. We use an external-content-free table and manage rows by
-- a stable integer derived from task insertion (see fts.ts).
CREATE VIRTUAL TABLE task_fts USING fts5(
  task_id UNINDEXED,
  title,
  body,
  labels_text,
  tokenize='porter unicode61'
);

-- ─────────────────────────────── EMBEDDING QUEUE ──────────────────────
CREATE TABLE embedding_queue (
  task_id     TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  enqueued_at TEXT NOT NULL
);

-- ─────────────────────────────── META ─────────────────────────────────
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
