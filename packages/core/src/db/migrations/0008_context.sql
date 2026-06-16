-- Phase C: schema-free per-entity context bag (Q3). Each entity carries a
-- namespace→value map that extensions own slots in, mutated only via
-- ContextUpdated events and folded into this column. Large values are spilled
-- to the content-addressed blob store (claim-check) and stored as {"$ref":…}.

ALTER TABLE task ADD COLUMN context TEXT NOT NULL DEFAULT '{}';
ALTER TABLE intake ADD COLUMN context TEXT NOT NULL DEFAULT '{}';
