-- One workspace per task (strictly 1:1). DB is a rebuildable cache over the
-- tasktree registry + `tq.task-id` annotations / `.tq.json` markers.
CREATE TABLE workspace (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES task(id) ON DELETE SET NULL,  -- SET NULL ⇒ detach, never cascade-delete disk
  provider     TEXT NOT NULL,                                -- 'tasktree' | 'local'
  root_path    TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ready',                -- provisioning|ready|error|detached
  error        TEXT,
  meta         TEXT,                                         -- JSON: provider info bag (repos, template, …)
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);
-- Enforce 1:1 only for live links (a detached row sets task_id NULL).
CREATE UNIQUE INDEX idx_workspace_task ON workspace(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_workspace_path ON workspace(root_path);
