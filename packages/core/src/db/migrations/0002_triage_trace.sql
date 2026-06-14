-- Persist the triage LLM session transcript so the dashboard can show what the
-- agent actually did (reasoning, searches, results) — captured on both success
-- and failure for observability/debugging.
ALTER TABLE intake ADD COLUMN triage_trace TEXT; -- JSON: TriageTraceStep[]
