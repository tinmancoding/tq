import type { Store } from "../store.js";
import { now } from "../domain/ids.js";
import { search } from "../search/hybrid.js";
import { decideGate, type GateAction } from "./gate.js";
import type { TriageEngine, TriageImage, TriageSearchHit } from "./engine.js";
import type { TriageResult } from "../domain/types.js";

const TRIAGE_ACTOR = "agent:triage";

export interface WorkerPoolOptions {
  concurrency: number;
  maxAttempts: number;
  autoCreateConfidence: number;
  /** Base backoff seconds; attempt N waits base * 2^(N-1). */
  backoffBaseSec?: number;
  /** Poll interval when the queue is idle (ms). */
  pollIntervalMs?: number;
  /** Loads image attachments for an intake (Phase 2D wires the real loader). */
  loadImages?: (intakeId: string) => TriageImage[];
}

interface ClaimedJob {
  id: string;
  intake_id: string;
  attempts: number;
  max_attempts: number;
}

/**
 * In-process triage worker pool. Claims queued jobs atomically (UPDATE …
 * RETURNING), runs the injected TriageEngine, persists the result, applies the
 * gate, and reschedules failures with exponential backoff.
 */
export class TriageWorkerPool {
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  private unsub: (() => void) | null = null;
  private stopped = true;

  constructor(
    private readonly store: Store,
    private readonly engine: TriageEngine,
    private readonly opts: WorkerPoolOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Kick on new jobs, and poll as a safety net (handles backoff schedules).
    this.unsub = this.store.bus.subscribe((e) => {
      if (e.event === "job.queued") this.dispatch();
    });
    this.timer = setInterval(() => this.dispatch(), this.opts.pollIntervalMs ?? 2000);
    this.dispatch();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsub?.();
    this.unsub = null;
  }

  /** Dispatch as many jobs as capacity allows. */
  private dispatch(): void {
    if (this.stopped) return;
    while (this.inFlight < this.opts.concurrency) {
      const job = this.claimNext();
      if (!job) break;
      this.inFlight++;
      this.store.bus.emit("job.started", { id: job.id, intake_id: job.intake_id });
      void this.process(job).finally(() => {
        this.inFlight--;
        this.emitSummary();
        // A slot freed up; try to pick up more work.
        if (!this.stopped) this.dispatch();
      });
    }
    this.emitSummary();
  }

  /** Atomically move one eligible queued job to `running`. */
  private claimNext(): ClaimedJob | null {
    const ts = now();
    const row = this.store.db
      .prepare(
        `UPDATE triage_job
            SET status = 'running', started_at = @ts, attempts = attempts + 1
          WHERE id = (
            SELECT id FROM triage_job
             WHERE status = 'queued'
               AND (next_run_at IS NULL OR next_run_at <= @ts)
             ORDER BY created_at
             LIMIT 1
          )
        RETURNING id, intake_id, attempts, max_attempts`,
      )
      .get({ ts }) as ClaimedJob | undefined;
    return row ?? null;
  }

  private async process(job: ClaimedJob): Promise<void> {
    try {
      const intake = this.store.intake.get(job.intake_id);
      if (!intake) {
        this.finishJob(job.id, "done");
        return;
      }
      const images = this.opts.loadImages?.(job.intake_id) ?? [];
      const result = await this.engine.triage({ intake, images }, (q, limit) =>
        this.searchTasks(q, limit),
      );

      // Persist result (flips intake → triaged) then apply the gate.
      this.store.intake.setTriageResult(job.intake_id, result);
      this.applyGate(job.intake_id, result);
      this.finishJob(job.id, "done");
    } catch (err) {
      this.handleError(job, err);
    }
  }

  private searchTasks(query: string, limit: number): TriageSearchHit[] {
    const res = search(this.store.db, this.store.tasks, query, { limit });
    return res.hits.map((h) => ({
      id: h.task.id,
      title: h.task.title,
      snippet: (h.task.body ?? "").slice(0, 200),
      labels: h.task.labels,
      status: h.task.status,
      score: h.score,
    }));
  }

  private applyGate(intakeId: string, result: TriageResult): void {
    const action: GateAction = decideGate(result, this.opts.autoCreateConfidence);
    switch (action.kind) {
      case "auto_link": {
        const linked = this.store.intake.link(intakeId, action.task_id, "linked", TRIAGE_ACTOR);
        if (!linked) {
          // Candidate vanished — fall back to manual review (leave triaged).
          return;
        }
        return;
      }
      case "auto_create": {
        this.store.intake.promote(intakeId, { created_by: TRIAGE_ACTOR, status: "backlog" });
        return;
      }
      case "review":
        // Leave as `triaged` for the inbox; nothing else to do.
        return;
    }
  }

  private handleError(job: ClaimedJob, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.store.intake.setTriageError(job.intake_id, message);
    if (job.attempts >= job.max_attempts) {
      this.store.db
        .prepare(
          `UPDATE triage_job SET status = 'error', last_error = ?, finished_at = ? WHERE id = ?`,
        )
        .run(message, now(), job.id);
      this.store.bus.emit("job.error", { id: job.id, intake_id: job.intake_id, error: message });
      return;
    }
    const base = this.opts.backoffBaseSec ?? 30;
    const delaySec = base * 2 ** (job.attempts - 1);
    const nextRun = new Date(Date.now() + delaySec * 1000).toISOString();
    this.store.db
      .prepare(
        `UPDATE triage_job SET status = 'queued', last_error = ?, next_run_at = ?, started_at = NULL WHERE id = ?`,
      )
      .run(message, nextRun, job.id);
    this.store.bus.emit("job.queued", { id: job.id, intake_id: job.intake_id, retry: true });
  }

  private finishJob(id: string, status: "done"): void {
    this.store.db
      .prepare(`UPDATE triage_job SET status = ?, finished_at = ? WHERE id = ?`)
      .run(status, now(), id);
    this.store.bus.emit("job.done", { id });
  }

  private emitSummary(): void {
    this.store.bus.emit("jobs.summary", this.store.jobs.counts());
  }

  /** For tests/manual drains: process all currently-claimable jobs and wait. */
  async drain(): Promise<void> {
    this.stopped = false;
    // Repeatedly dispatch until no queued (non-backed-off) jobs remain idle.
    for (;;) {
      this.dispatch();
      if (this.inFlight === 0) {
        const pending = this.store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM triage_job WHERE status = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?)`,
          )
          .get(now()) as { n: number };
        if (pending.n === 0) return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
