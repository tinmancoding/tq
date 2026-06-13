import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import { now } from "./ids.js";

export interface TriageJob {
  id: string;
  intake_id: string;
  status: "queued" | "running" | "done" | "error";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_run_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export class JobRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventBus,
  ) {}

  list(opts: { status?: TriageJob["status"]; limit?: number } = {}): TriageJob[] {
    const where = opts.status ? `WHERE status = ?` : "";
    const params = opts.status ? [opts.status] : [];
    return this.db
      .prepare(`SELECT * FROM triage_job ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 100) as TriageJob[];
  }

  get(id: string): TriageJob | null {
    return (this.db.prepare(`SELECT * FROM triage_job WHERE id = ?`).get(id) as TriageJob) ?? null;
  }

  counts(): Record<TriageJob["status"], number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM triage_job GROUP BY status`)
      .all() as { status: TriageJob["status"]; n: number }[];
    const out = { queued: 0, running: 0, done: 0, error: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  requeue(id: string): TriageJob | null {
    const job = this.get(id);
    if (!job) return null;
    this.db
      .prepare(
        `UPDATE triage_job SET status = 'queued', last_error = NULL, next_run_at = ?,
           started_at = NULL, finished_at = NULL WHERE id = ?`,
      )
      .run(now(), id);
    this.bus.emit("job.queued", { id, intake_id: job.intake_id });
    return this.get(id);
  }

  /** Crash recovery: reset jobs stuck in `running` back to `queued`. */
  recoverRunning(): number {
    const res = this.db
      .prepare(`UPDATE triage_job SET status = 'queued', started_at = NULL WHERE status = 'running'`)
      .run();
    return res.changes;
  }
}
