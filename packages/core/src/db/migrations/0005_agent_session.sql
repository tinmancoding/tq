-- Indexed projection of pi .jsonl sessions discovered under a task's workspace
-- roots. Source of truth for content stays the .jsonl; rows survive file deletion
-- as tombstones.
CREATE TABLE agent_session (
  id               TEXT PRIMARY KEY,           -- pi session uuid (from header)
  task_id          TEXT REFERENCES task(id) ON DELETE SET NULL,
  workspace_id     TEXT REFERENCES workspace(id) ON DELETE SET NULL,
  session_file     TEXT NOT NULL UNIQUE,       -- absolute path to the .jsonl
  cwd              TEXT NOT NULL,
  title            TEXT,                        -- first user prompt (truncated)
  model            TEXT,
  message_count    INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT,
  last_activity_at TEXT,                        -- file mtime
  status           TEXT NOT NULL DEFAULT 'seen',-- seen|active|ended (heuristic via mtime window)
  file_present     INTEGER NOT NULL DEFAULT 1,  -- 0 ⇒ tombstone (file deleted)
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_session_task ON agent_session(task_id, last_activity_at DESC);
CREATE INDEX idx_session_ws ON agent_session(workspace_id);
