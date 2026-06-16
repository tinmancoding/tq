/**
 * One-time migration: synthesize genesis events for entities that predate the
 * event log, and migrate intake.triage → context.triage. Idempotent.
 *
 * Run with the daemon STOPPED, against the configured DB:
 *   pnpm --filter @tq/cli exec tsx ../../scripts/backfill-events.ts
 * or with an explicit profile:
 *   TQ_CONFIG=/path/to/config.toml tsx scripts/backfill-events.ts
 *
 * Back up the DB first (see docs/event-driven-implementation-plan.md, Phase C).
 */
import { loadConfig, Store, backfillEvents } from "@tq/core";

const cfg = loadConfig();
// eslint-disable-next-line no-console
console.error(`[backfill] opening ${cfg.daemon.db_path}`);
const store = Store.open({
  path: cfg.daemon.db_path,
  embeddingDims: cfg.embeddings.dims,
  attachmentsDir: cfg.daemon.attachments_dir,
  contextSpillBytes: cfg.context.spill_bytes,
});

const res = backfillEvents(store);
store.close();

if (res.alreadyDone) {
  // eslint-disable-next-line no-console
  console.error("[backfill] already applied (schema_meta flag set) — nothing to do");
} else {
  // eslint-disable-next-line no-console
  console.error(
    `[backfill] done: ${res.tasks} task(s), ${res.intakes} intake(s), ${res.activities} activity event(s) synthesized`,
  );
}
