import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import type { EventStore } from "./event.js";
import { newId, now } from "./ids.js";
import {
  type Intake,
  type IntakeStatus,
  type Label,
  type Priority,
  type TaskStatus,
  type TriageResult,
  type TriageTraceStep,
  DEFAULT_ACTOR,
} from "./types.js";
import type { TaskRepo } from "./task.js";

export interface CreateIntakeInput {
  body?: string | null;
  source?: string;
  source_ref?: string | null;
  event_sig?: string | null;
  action_verbs?: string[];
  labels?: Record<string, string>;
  watchlist_id?: string | null;
  /** When true, do not enqueue a triage job yet (caller will after linking attachments). */
  deferTriage?: boolean;
}

export interface PromoteInput {
  title?: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: Priority | null;
  labels?: Label[];
  created_by?: string;
}

interface IntakeRow {
  id: string;
  status: IntakeStatus;
  source: string;
  source_ref: string | null;
  event_sig: string | null;
  body: string | null;
  action_verbs: string | null;
  discard_reason: string | null;
  triage: string | null;
  triage_error: string | null;
  triage_trace: string | null;
  labels: string | null;
  watchlist_id: string | null;
  created_at: string;
  triaged_at: string | null;
  context: string;
}

export class IntakeRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventBus,
    private readonly tasks: TaskRepo,
    private readonly events: EventStore,
  ) {}

  /**
   * Create an intake and enqueue a triage job. Idempotent for polled events:
   * a duplicate (source, event_sig) returns the existing intake without
   * creating a new job.
   */
  create(input: CreateIntakeInput): { intake: Intake; created: boolean } {
    const id = newId();
    const ts = now();
    const source = input.source ?? "manual";
    let createdId = id;
    let created = true;

    const tx = this.db.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO intake
             (id, status, source, source_ref, event_sig, body, action_verbs,
              labels, watchlist_id, created_at)
           VALUES (@id, 'new', @source, @source_ref, @event_sig, @body,
                   @action_verbs, @labels, @watchlist_id, @created_at)`,
        )
        .run({
          id,
          source,
          source_ref: input.source_ref ?? null,
          event_sig: input.event_sig ?? null,
          body: input.body ?? null,
          action_verbs: input.action_verbs ? JSON.stringify(input.action_verbs) : null,
          labels: input.labels ? JSON.stringify(input.labels) : null,
          watchlist_id: input.watchlist_id ?? null,
          created_at: ts,
        });
      if (res.changes === 0 && input.event_sig) {
        // Idempotent hit: fetch the pre-existing row.
        const existing = this.db
          .prepare(`SELECT id FROM intake WHERE source = ? AND event_sig = ?`)
          .get(source, input.event_sig) as { id: string } | undefined;
        if (existing) {
          createdId = existing.id;
          created = false;
          return;
        }
      }
      if (!input.deferTriage) this.enqueueJob(createdId, ts);
      this.events.append({
        type: "IntakeCaptured",
        scopeType: "intake",
        scopeId: createdId,
        actor: DEFAULT_ACTOR,
        payload: {
          source,
          source_ref: input.source_ref ?? null,
          event_sig: input.event_sig ?? null,
          body: input.body ?? null,
          action_verbs: input.action_verbs ?? null,
          labels: input.labels ?? null,
          watchlist_id: input.watchlist_id ?? null,
        },
      });
    });
    tx();

    const intake = this.get(createdId)!;
    if (created) this.bus.emit("intake.created", intake);
    return { intake, created };
  }

  /** Enqueue a triage job for an intake (used after deferred capture). */
  queueTriage(id: string): void {
    this.enqueueJob(id, now());
  }

  get(id: string): Intake | null {
    const row = this.db.prepare(`SELECT * FROM intake WHERE id = ?`).get(id) as
      | IntakeRow
      | undefined;
    return row ? hydrateIntake(row) : null;
  }

  resolveId(prefix: string): string | null {
    const exact = this.db.prepare(`SELECT id FROM intake WHERE id = ?`).get(prefix) as
      | { id: string }
      | undefined;
    if (exact) return exact.id;
    const rows = this.db
      .prepare(`SELECT id FROM intake WHERE id LIKE ? LIMIT 2`)
      .all(`${prefix}%`) as { id: string }[];
    return rows.length === 1 ? rows[0]!.id : null;
  }

  list(opts: { status?: IntakeStatus; source?: string; limit?: number; offset?: number } = {}): Intake[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push(`status = ?`);
      params.push(opts.status);
    }
    if (opts.source) {
      where.push(`source = ?`);
      params.push(opts.source);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM intake ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit ?? 200, opts.offset ?? 0) as IntakeRow[];
    return rows.map(hydrateIntake);
  }

  /** Record a triage result and flip status to triaged. */
  setTriageResult(id: string, result: TriageResult): Intake | null {
    const prev = this.get(id);
    if (!prev) return null;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE intake SET triage = ?, triage_error = NULL, status = 'triaged', triaged_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(result), now(), id);
      if (prev.status !== "triaged") {
        this.events.append({
          type: "IntakeStatusChanged",
          scopeType: "intake",
          scopeId: id,
          actor: "agent:triage",
          payload: { from: prev.status, to: "triaged" },
        });
      }
    });
    tx();
    const intake = this.get(id)!;
    this.bus.emit("intake.triaged", intake);
    return intake;
  }

  setTriageError(id: string, error: string): void {
    this.db.prepare(`UPDATE intake SET triage_error = ? WHERE id = ?`).run(error, id);
  }

  /** Persist the LLM session transcript for an intake (success or failure). */
  setTriageTrace(id: string, trace: TriageTraceStep[]): void {
    this.db
      .prepare(`UPDATE intake SET triage_trace = ? WHERE id = ?`)
      .run(JSON.stringify(trace), id);
  }

  /** Promote an intake into a new task, carrying over triage suggestions. */
  promote(id: string, input: PromoteInput = {}): { intake: Intake; taskId: string } | null {
    const intake = this.get(id);
    if (!intake) return null;
    const triage = intake.triage as TriageResult | null;

    const title = input.title ?? triage?.suggested_title ?? firstLine(intake.body) ?? "Untitled";
    const body = input.body ?? triage?.suggested_body ?? intake.body ?? null;
    const labels: Label[] = input.labels ?? triage?.suggested_labels ?? labelsFromMap(intake.labels);
    const refs = (triage?.refs ?? []).map((r) => ({
      kind: r.kind,
      url: r.url,
      external_id: r.external_id ?? null,
      title: r.title ?? null,
      meta: null,
    }));

    let taskId = "";
    const tx = this.db.transaction(() => {
      const task = this.tasks.create({
        title,
        body,
        status: input.status ?? "backlog",
        priority: input.priority ?? triage?.suggested_priority ?? null,
        labels,
        refs,
        created_by: input.created_by ?? DEFAULT_ACTOR,
      });
      taskId = task.id;
      this.linkInternal(id, taskId, "source");
      this.tasks.addActivity(taskId, {
        entry_type: "system",
        actor: input.created_by ?? DEFAULT_ACTOR,
        body: `promoted from intake ${id.slice(0, 8)}`,
        meta: { intake_id: id },
      });
      this.markPromoted(id);
      this.events.append({
        type: "IntakePromoted",
        scopeType: "intake",
        scopeId: id,
        actor: input.created_by ?? DEFAULT_ACTOR,
        payload: { task_id: taskId },
      });
      if (intake.status !== "promoted") {
        this.events.append({
          type: "IntakeStatusChanged",
          scopeType: "intake",
          scopeId: id,
          actor: input.created_by ?? DEFAULT_ACTOR,
          payload: { from: intake.status, to: "promoted" },
        });
      }
    });
    tx();
    const updated = this.get(id)!;
    this.bus.emit("intake.promoted", { intake: updated, task_id: taskId });
    return { intake: updated, taskId };
  }

  /** Link an intake to an existing task (no new task created). */
  link(id: string, taskId: string, relation = "linked", actor = DEFAULT_ACTOR): Intake | null {
    const intake = this.get(id);
    if (!intake) return null;
    if (!this.tasks.get(taskId)) return null;
    const tx = this.db.transaction(() => {
      this.linkInternal(id, taskId, relation);
      this.tasks.addActivity(taskId, {
        entry_type: "system",
        actor,
        body: `linked intake ${id.slice(0, 8)}`,
        meta: { intake_id: id, relation },
      });
      this.markPromoted(id);
      this.events.append({
        type: "IntakeLinked",
        scopeType: "intake",
        scopeId: id,
        actor,
        payload: { task_id: taskId, relation },
      });
      if (intake.status !== "promoted") {
        this.events.append({
          type: "IntakeStatusChanged",
          scopeType: "intake",
          scopeId: id,
          actor,
          payload: { from: intake.status, to: "promoted" },
        });
      }
    });
    tx();
    const updated = this.get(id)!;
    this.bus.emit("intake.promoted", { intake: updated, task_id: taskId });
    return updated;
  }

  discard(id: string, reason: string): Intake | null {
    const prev = this.get(id);
    if (!prev) return null;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE intake SET status = 'discarded', discard_reason = ? WHERE id = ?`)
        .run(reason, id);
      this.events.append({
        type: "IntakeStatusChanged",
        scopeType: "intake",
        scopeId: id,
        actor: DEFAULT_ACTOR,
        payload: { from: prev.status, to: "discarded", reason },
      });
    });
    tx();
    const intake = this.get(id)!;
    this.bus.emit("intake.discarded", intake);
    return intake;
  }

  /** Requeue a triage job for this intake. */
  retriage(id: string): Intake | null {
    const intake = this.get(id);
    if (!intake) return null;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE intake SET status = 'new', triage_error = NULL, triage_trace = NULL WHERE id = ?`)
        .run(id);
      if (intake.status !== "new") {
        this.events.append({
          type: "IntakeStatusChanged",
          scopeType: "intake",
          scopeId: id,
          actor: DEFAULT_ACTOR,
          payload: { from: intake.status, to: "new" },
        });
      }
      this.enqueueJob(id, now());
    });
    tx();
    return this.get(id)!;
  }

  linkedTaskIds(id: string): string[] {
    return (
      this.db
        .prepare(`SELECT task_id FROM intake_task WHERE intake_id = ?`)
        .all(id) as { task_id: string }[]
    ).map((r) => r.task_id);
  }

  /** Reverse of linkedTaskIds: intakes linked to a given task (for task detail). */
  forTask(taskId: string): { id: string; relation: string; summary: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT it.intake_id AS id, it.relation AS relation, i.triage AS triage
           FROM intake_task it JOIN intake i ON i.id = it.intake_id
          WHERE it.task_id = ?
          ORDER BY it.created_at ASC`,
      )
      .all(taskId) as { id: string; relation: string; triage: string | null }[];
    return rows.map((r) => {
      let summary: string | null = null;
      if (r.triage) {
        try {
          summary = (JSON.parse(r.triage) as { summary?: string }).summary ?? null;
        } catch {
          summary = null;
        }
      }
      return { id: r.id, relation: r.relation, summary };
    });
  }

  // ── helpers ──
  private enqueueJob(intakeId: string, ts: string): void {
    this.db
      .prepare(
        `INSERT INTO triage_job (id, intake_id, status, created_at, next_run_at)
         VALUES (?, ?, 'queued', ?, ?)`,
      )
      .run(newId(), intakeId, ts, ts);
    this.bus.emit("job.queued", { intake_id: intakeId });
  }

  private linkInternal(intakeId: string, taskId: string, relation: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO intake_task (intake_id, task_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(intakeId, taskId, relation, now());
  }

  private markPromoted(id: string): void {
    this.db.prepare(`UPDATE intake SET status = 'promoted' WHERE id = ?`).run(id);
  }
}

function hydrateIntake(row: IntakeRow): Intake {
  return {
    ...row,
    action_verbs: row.action_verbs ? JSON.parse(row.action_verbs) : null,
    triage: row.triage ? JSON.parse(row.triage) : null,
    triage_trace: row.triage_trace ? JSON.parse(row.triage_trace) : null,
    labels: row.labels ? JSON.parse(row.labels) : null,
    context: row.context ? JSON.parse(row.context) : {},
  };
}

function labelsFromMap(map: Record<string, string> | null): Label[] {
  if (!map) return [];
  return Object.entries(map).map(([key, value]) => ({ key, value }));
}

function firstLine(s: string | null): string | null {
  if (!s) return null;
  const line = s.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 120) : null;
}
