-- Phase A: remove the workspaces & agent-sessions feature (reverting the MVP).
-- These were rebuildable caches with no precious data; dropping them is safe.
-- They will return later as the @tq/ext-workspaces extension (never in core).
-- See docs/event-driven-architecture.md §10.

DROP TABLE IF EXISTS agent_session;
DROP TABLE IF EXISTS workspace;
