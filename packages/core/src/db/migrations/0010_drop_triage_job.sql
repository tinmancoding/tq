-- Phase G2 cleanup. Triage is now the @tq/ext-triage extension; its result and
-- transcript live in the intake's `context` bag. Move any legacy column data
-- into context, then drop the dead columns and the retired in-core triage job
-- queue. (SQLite >= 3.35 supports ALTER TABLE DROP COLUMN.)

UPDATE intake SET context = json_set(context, '$.triage', json(triage))
  WHERE triage IS NOT NULL AND json_valid(triage);
UPDATE intake SET context = json_set(context, '$.triage_error', triage_error)
  WHERE triage_error IS NOT NULL;
UPDATE intake SET context = json_set(context, '$.triage_trace', json(triage_trace))
  WHERE triage_trace IS NOT NULL AND json_valid(triage_trace);

ALTER TABLE intake DROP COLUMN triage;
ALTER TABLE intake DROP COLUMN triage_error;
ALTER TABLE intake DROP COLUMN triage_trace;

DROP TABLE IF EXISTS triage_job;
