import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import type { EventStore } from "./event.js";
import { newId, now } from "./ids.js";
import {
  type Activity,
  type EntryType,
  type Label,
  type Priority,
  type Task,
  type TaskRef,
  type TaskStatus,
  DEFAULT_ACTOR,
  TASK_STATUSES,
} from "./types.js";
import { indexTask, removeFromIndex } from "../search/fts.js";
import { removeTaskVector } from "../search/vector.js";

export interface CreateTaskInput {
  title: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: Priority | null;
  due_at?: string | null;
  snooze_until?: string | null;
  board_rank?: string | null;
  labels?: Label[];
  refs?: Omit<TaskRef, "id" | "task_id">[];
  created_by?: string;
}

export interface UpdateTaskInput {
  title?: string;
  body?: string | null;
  priority?: Priority | null;
  due_at?: string | null;
  snooze_until?: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: Priority | null;
  due_at: string | null;
  snooze_until: string | null;
  board_rank: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  status_changed_at: string;
  context: string;
}

export class TaskRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventBus,
    private readonly events: EventStore,
  ) {}

  create(input: CreateTaskInput): Task {
    const id = newId();
    const ts = now();
    const status = input.status ?? "backlog";
    const tx = this.events.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO task
             (id, title, body, status, priority, due_at, snooze_until, board_rank,
              created_by, created_at, updated_at, done_at, status_changed_at)
           VALUES (@id, @title, @body, @status, @priority, @due_at, @snooze_until,
                   @board_rank, @created_by, @created_at, @updated_at, @done_at, @status_changed_at)`,
        )
        .run({
          id,
          title: input.title,
          body: input.body ?? null,
          status,
          priority: input.priority ?? null,
          due_at: input.due_at ?? null,
          snooze_until: input.snooze_until ?? null,
          board_rank: input.board_rank ?? null,
          created_by: input.created_by ?? DEFAULT_ACTOR,
          created_at: ts,
          updated_at: ts,
          done_at: status === "done" ? ts : null,
          status_changed_at: ts,
        });
      for (const l of input.labels ?? []) this.insertLabel(id, l);
      for (const r of input.refs ?? []) this.insertRef(id, r);
      this.reindex(id);
      this.enqueueEmbedding(id, ts);
      this.events.append({
        type: "TaskCreated",
        scopeType: "task",
        scopeId: id,
        actor: input.created_by ?? DEFAULT_ACTOR,
        payload: {
          title: input.title,
          body: input.body ?? null,
          status,
          priority: input.priority ?? null,
          due_at: input.due_at ?? null,
          snooze_until: input.snooze_until ?? null,
          board_rank: input.board_rank ?? null,
          labels: input.labels ?? [],
          refs: input.refs ?? [],
          created_by: input.created_by ?? DEFAULT_ACTOR,
        },
      });
    });
    tx();
    const task = this.get(id)!;
    this.bus.emit("task.created", task);
    return task;
  }

  get(id: string): Task | null {
    const row = this.db.prepare(`SELECT * FROM task WHERE id = ?`).get(id) as
      | TaskRow
      | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  /** Resolve a possibly-truncated id prefix to a full id. */
  resolveId(prefix: string): string | null {
    const exact = this.db.prepare(`SELECT id FROM task WHERE id = ?`).get(prefix) as
      | { id: string }
      | undefined;
    if (exact) return exact.id;
    const rows = this.db
      .prepare(`SELECT id FROM task WHERE id LIKE ? LIMIT 2`)
      .all(`${prefix}%`) as { id: string }[];
    if (rows.length === 1) return rows[0]!.id;
    return null;
  }

  list(opts: {
    status?: TaskStatus;
    label?: Label;
    limit?: number;
    offset?: number;
  } = {}): Task[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push(`t.status = ?`);
      params.push(opts.status);
    }
    if (opts.label) {
      where.push(
        `EXISTS (SELECT 1 FROM task_label tl WHERE tl.task_id = t.id AND tl.key = ? AND tl.value = ?)`,
      );
      params.push(opts.label.key, opts.label.value);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts.limit ?? 200;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT t.* FROM task t ${whereSql}
          ORDER BY (t.board_rank IS NULL), t.board_rank ASC, t.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as TaskRow[];
    return rows.map((r) => this.hydrate(r));
  }

  update(id: string, input: UpdateTaskInput): Task | null {
    const existing = this.get(id);
    if (!existing) return null;
    const fields: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: now() };
    const changed: Record<string, unknown> = {};
    for (const key of [
      "title",
      "body",
      "priority",
      "due_at",
      "snooze_until",
    ] as const) {
      if (key in input && input[key] !== undefined) {
        fields.push(`${key} = @${key}`);
        params[key] = input[key];
        changed[key] = input[key];
      }
    }
    fields.push(`updated_at = @updated_at`);
    const tx = this.events.transaction(() => {
      this.db.prepare(`UPDATE task SET ${fields.join(", ")} WHERE id = @id`).run(params);
      if ("title" in input || "body" in input) {
        this.reindex(id);
        this.enqueueEmbedding(id, params.updated_at as string);
      }
      this.events.append({
        type: "TaskUpdated",
        scopeType: "task",
        scopeId: id,
        actor: DEFAULT_ACTOR,
        payload: { changed },
      });
    });
    tx();
    const task = this.get(id)!;
    this.bus.emit("task.updated", task);
    return task;
  }

  move(id: string, status: TaskStatus, boardRank?: string | null, actor = DEFAULT_ACTOR): Task | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (!TASK_STATUSES.includes(status)) return null;
    const ts = now();
    const tx = this.events.transaction(() => {
      this.db
        .prepare(
          `UPDATE task SET status = @status,
             board_rank = COALESCE(@board_rank, board_rank),
             done_at = CASE WHEN @status = 'done' THEN @ts ELSE NULL END,
             status_changed_at = CASE WHEN @prev_status <> @status THEN @ts ELSE status_changed_at END,
             updated_at = @ts
           WHERE id = @id`,
        )
        .run({ id, status, board_rank: boardRank ?? null, ts, prev_status: existing.status });
      if (existing.status !== status) {
        this.insertActivity(id, {
          entry_type: "system",
          actor,
          body: `status: ${existing.status} → ${status}`,
          meta: { from: existing.status, to: status },
        });
      }
      this.events.append({
        type: "TaskMoved",
        scopeType: "task",
        scopeId: id,
        actor,
        payload: { from: existing.status, to: status, board_rank: boardRank ?? null },
      });
    });
    tx();
    const task = this.get(id)!;
    this.bus.emit("task.moved", task);
    return task;
  }

  /** Soft delete → `dropped`, or hard delete when `hard` is true. */
  remove(id: string, hard = false): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    if (hard) {
      const tx = this.events.transaction(() => {
        this.events.append({
          type: "TaskDeleted",
          scopeType: "task",
          scopeId: id,
          actor: DEFAULT_ACTOR,
          payload: { hard: true },
        });
        removeFromIndex(this.db, id);
        removeTaskVector(this.db, id);
        this.db.prepare(`DELETE FROM task WHERE id = ?`).run(id);
      });
      tx();
      this.bus.emit("task.updated", { id, deleted: true });
      return true;
    }
    this.move(id, "dropped");
    return true;
  }

  // ── labels ──
  addLabel(id: string, label: Label): Task | null {
    if (!this.get(id)) return null;
    const tx = this.events.transaction(() => {
      this.insertLabel(id, label);
      this.reindex(id);
      this.events.append({
        type: "LabelAdded",
        scopeType: "task",
        scopeId: id,
        actor: DEFAULT_ACTOR,
        payload: { key: label.key, value: label.value },
      });
    });
    tx();
    const task = this.get(id)!;
    this.bus.emit("task.updated", task);
    return task;
  }

  removeLabel(id: string, label: Label): Task | null {
    if (!this.get(id)) return null;
    const tx = this.events.transaction(() => {
      this.db
        .prepare(`DELETE FROM task_label WHERE task_id = ? AND key = ? AND value = ?`)
        .run(id, label.key, label.value);
      this.reindex(id);
      this.events.append({
        type: "LabelRemoved",
        scopeType: "task",
        scopeId: id,
        actor: DEFAULT_ACTOR,
        payload: { key: label.key, value: label.value },
      });
    });
    tx();
    const task = this.get(id)!;
    this.bus.emit("task.updated", task);
    return task;
  }

  // ── refs ──
  addRef(id: string, ref: Omit<TaskRef, "id" | "task_id">): TaskRef | null {
    if (!this.get(id)) return null;
    let refId = "";
    const tx = this.events.transaction(() => {
      refId = this.insertRef(id, ref);
      this.events.append({
        type: "RefAdded",
        scopeType: "task",
        scopeId: id,
        actor: DEFAULT_ACTOR,
        payload: {
          kind: ref.kind,
          url: ref.url,
          external_id: ref.external_id ?? null,
          title: ref.title ?? null,
          meta: ref.meta ?? null,
        },
      });
    });
    tx();
    this.bus.emit("task.updated", this.get(id));
    return this.db.prepare(`SELECT * FROM task_ref WHERE id = ?`).get(refId) as TaskRef;
  }

  // ── activity ──
  addActivity(
    id: string,
    entry: { entry_type: EntryType; actor: string; body: string; meta?: unknown },
  ): Activity | null {
    if (!this.get(id)) return null;
    let actId = "";
    const tx = this.events.transaction(() => {
      actId = this.insertActivity(id, entry);
      if (entry.entry_type === "worklog") {
        this.events.append({
          type: "WorkLogged",
          scopeType: "task",
          scopeId: id,
          actor: entry.actor,
          payload: { description: entry.body, additionalContext: entry.meta ?? undefined },
        });
      } else if (entry.entry_type === "comment") {
        this.events.append({
          type: "CommentAdded",
          scopeType: "task",
          scopeId: id,
          actor: entry.actor,
          payload: { body: entry.body },
        });
      }
    });
    tx();
    const activity = this.db
      .prepare(`SELECT * FROM activity WHERE id = ?`)
      .get(actId) as ActivityRow;
    const out = hydrateActivity(activity);
    this.bus.emit("task.activity", out);
    return out;
  }

  listActivity(id: string): Activity[] {
    const rows = this.db
      .prepare(`SELECT * FROM activity WHERE task_id = ? ORDER BY created_at ASC`)
      .all(id) as ActivityRow[];
    return rows.map(hydrateActivity);
  }

  // ── helpers ──
  private hydrate(row: TaskRow): Task {
    const labels = this.db
      .prepare(`SELECT key, value FROM task_label WHERE task_id = ? ORDER BY key, value`)
      .all(row.id) as Label[];
    const refs = this.db
      .prepare(`SELECT * FROM task_ref WHERE task_id = ? ORDER BY id`)
      .all(row.id) as RefRow[];
    return {
      ...row,
      context: row.context ? JSON.parse(row.context) : {},
      labels,
      refs: refs.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })),
    };
  }

  private reindex(id: string): void {
    const row = this.db.prepare(`SELECT id, title, body FROM task WHERE id = ?`).get(id) as
      | { id: string; title: string; body: string | null }
      | undefined;
    if (!row) return;
    const labels = this.db
      .prepare(`SELECT key, value FROM task_label WHERE task_id = ?`)
      .all(id) as Label[];
    indexTask(this.db, { ...row, labels });
  }

  private enqueueEmbedding(id: string, ts: string): void {
    this.db
      .prepare(
        `INSERT INTO embedding_queue (task_id, enqueued_at) VALUES (?, ?)
         ON CONFLICT(task_id) DO UPDATE SET enqueued_at = excluded.enqueued_at`,
      )
      .run(id, ts);
  }

  private insertLabel(id: string, label: Label): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_label (task_id, key, value) VALUES (?, ?, ?)`,
      )
      .run(id, label.key, label.value);
  }

  private insertRef(id: string, ref: Omit<TaskRef, "id" | "task_id">): string {
    const refId = newId();
    this.db
      .prepare(
        `INSERT INTO task_ref (id, task_id, kind, url, external_id, title, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        refId,
        id,
        ref.kind,
        ref.url,
        ref.external_id ?? null,
        ref.title ?? null,
        ref.meta ? JSON.stringify(ref.meta) : null,
      );
    return refId;
  }

  private insertActivity(
    id: string,
    entry: { entry_type: EntryType; actor: string; body: string; meta?: unknown },
  ): string {
    const actId = newId();
    this.db
      .prepare(
        `INSERT INTO activity (id, task_id, entry_type, actor, body, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actId,
        id,
        entry.entry_type,
        entry.actor,
        entry.body,
        entry.meta !== undefined ? JSON.stringify(entry.meta) : null,
        now(),
      );
    return actId;
  }
}

interface RefRow {
  id: string;
  task_id: string;
  kind: string;
  url: string;
  external_id: string | null;
  title: string | null;
  meta: string | null;
}

interface ActivityRow {
  id: string;
  task_id: string;
  entry_type: EntryType;
  actor: string;
  body: string;
  meta: string | null;
  created_at: string;
}

function hydrateActivity(row: ActivityRow): Activity {
  return { ...row, meta: row.meta ? JSON.parse(row.meta) : null };
}
