-- Track when a task last changed status, so the board can show how long a task
-- has been sitting in its current column. Backfill existing rows with their
-- last-updated time (the closest available proxy).
ALTER TABLE task ADD COLUMN status_changed_at TEXT;
UPDATE task SET status_changed_at = updated_at WHERE status_changed_at IS NULL;
