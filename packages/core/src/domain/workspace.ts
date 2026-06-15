import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import { newId, now } from "./ids.js";
import type { Workspace, WorkspaceStatus } from "./types.js";

export interface CreateWorkspaceInput {
  task_id: string;
  provider: string;
  root_path: string;
  name: string;
  status?: WorkspaceStatus;
  meta?: Record<string, unknown> | null;
}

/** A discovered/disk reference used to rebuild the cache (reconcile). */
export interface WorkspaceRef {
  provider: string;
  rootPath: string;
  name: string;
  taskId?: string;
  meta?: Record<string, unknown>;
}

interface WorkspaceRow {
  id: string;
  task_id: string | null;
  provider: string;
  root_path: string;
  name: string;
  status: WorkspaceStatus;
  error: string | null;
  meta: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export class WorkspaceRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventBus,
  ) {}

  /**
   * Create a workspace row for a task. Enforces the 1:1 invariant: a live
   * (non-detached) workspace already linked to the task is a conflict.
   */
  create(input: CreateWorkspaceInput): Workspace {
    const existing = this.getByTask(input.task_id);
    if (existing) {
      throw new WorkspaceConflictError(
        `task ${input.task_id} already has a workspace (${existing.id})`,
      );
    }
    const id = newId();
    const ts = now();
    const status = input.status ?? "ready";
    this.db
      .prepare(
        `INSERT INTO workspace
           (id, task_id, provider, root_path, name, status, error, meta, created_at, last_seen_at)
         VALUES (@id, @task_id, @provider, @root_path, @name, @status, NULL, @meta, @created_at, @last_seen_at)`,
      )
      .run({
        id,
        task_id: input.task_id,
        provider: input.provider,
        root_path: input.root_path,
        name: input.name,
        status,
        meta: input.meta ? JSON.stringify(input.meta) : null,
        created_at: ts,
        last_seen_at: ts,
      });
    const ws = this.get(id)!;
    this.bus.emit("workspace.created", ws);
    if (status === "provisioning") this.bus.emit("workspace.provisioning", ws);
    else if (status === "ready") this.bus.emit("workspace.ready", ws);
    return ws;
  }

  get(id: string): Workspace | null {
    const row = this.db.prepare(`SELECT * FROM workspace WHERE id = ?`).get(id) as
      | WorkspaceRow
      | undefined;
    return row ? hydrate(row) : null;
  }

  /** The live workspace for a task (ignores detached tombstones). */
  getByTask(taskId: string): Workspace | null {
    const row = this.db
      .prepare(`SELECT * FROM workspace WHERE task_id = ? AND status <> 'detached'`)
      .get(taskId) as WorkspaceRow | undefined;
    return row ? hydrate(row) : null;
  }

  getByPath(rootPath: string): Workspace | null {
    const row = this.db
      .prepare(`SELECT * FROM workspace WHERE root_path = ? ORDER BY created_at DESC`)
      .get(rootPath) as WorkspaceRow | undefined;
    return row ? hydrate(row) : null;
  }

  resolveId(prefix: string): string | null {
    const exact = this.db.prepare(`SELECT id FROM workspace WHERE id = ?`).get(prefix) as
      | { id: string }
      | undefined;
    if (exact) return exact.id;
    const rows = this.db
      .prepare(`SELECT id FROM workspace WHERE id LIKE ? LIMIT 2`)
      .all(`${prefix}%`) as { id: string }[];
    return rows.length === 1 ? rows[0]!.id : null;
  }

  list(opts: { status?: WorkspaceStatus; limit?: number } = {}): Workspace[] {
    const where = opts.status ? `WHERE status = ?` : "";
    const params = opts.status ? [opts.status] : [];
    const rows = this.db
      .prepare(`SELECT * FROM workspace ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 500) as WorkspaceRow[];
    return rows.map(hydrate);
  }

  setStatus(id: string, status: WorkspaceStatus, error?: string | null): Workspace | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(`UPDATE workspace SET status = ?, error = ?, last_seen_at = ? WHERE id = ?`)
      .run(status, error ?? null, now(), id);
    const ws = this.get(id)!;
    const evt = (
      {
        provisioning: "workspace.provisioning",
        ready: "workspace.ready",
        error: "workspace.error",
        detached: "workspace.detached",
      } as const
    )[status];
    this.bus.emit(evt, ws);
    return ws;
  }

  setMeta(id: string, meta: Record<string, unknown> | null): Workspace | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(`UPDATE workspace SET meta = ?, last_seen_at = ? WHERE id = ?`)
      .run(meta ? JSON.stringify(meta) : null, now(), id);
    return this.get(id);
  }

  touch(id: string): void {
    this.db.prepare(`UPDATE workspace SET last_seen_at = ? WHERE id = ?`).run(now(), id);
  }

  /** Detach: null the task link and tombstone the row. Never touches disk. */
  detach(id: string): Workspace | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(
        `UPDATE workspace SET status = 'detached', task_id = NULL, last_seen_at = ? WHERE id = ?`,
      )
      .run(now(), id);
    const ws = this.get(id)!;
    this.bus.emit("workspace.detached", ws);
    return ws;
  }

  /**
   * Upsert from a discovered disk reference (reconcile). Matches on root_path:
   * repairs the existing row or inserts a fresh `ready` one.
   */
  upsertFromRef(ref: WorkspaceRef): Workspace {
    const existing = this.getByPath(ref.rootPath);
    const ts = now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE workspace SET provider = ?, name = ?, meta = ?,
             task_id = COALESCE(?, task_id),
             status = CASE WHEN status = 'detached' AND ? IS NOT NULL THEN 'ready' ELSE status END,
             last_seen_at = ?
           WHERE id = ?`,
        )
        .run(
          ref.provider,
          ref.name,
          ref.meta ? JSON.stringify(ref.meta) : existing.meta ? JSON.stringify(existing.meta) : null,
          ref.taskId ?? null,
          ref.taskId ?? null,
          ts,
          existing.id,
        );
      return this.get(existing.id)!;
    }
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO workspace
           (id, task_id, provider, root_path, name, status, error, meta, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?)`,
      )
      .run(
        id,
        ref.taskId ?? null,
        ref.provider,
        ref.rootPath,
        ref.name,
        ref.meta ? JSON.stringify(ref.meta) : null,
        ts,
        ts,
      );
    const ws = this.get(id)!;
    this.bus.emit("workspace.created", ws);
    return ws;
  }
}

export class WorkspaceConflictError extends Error {}

function hydrate(row: WorkspaceRow): Workspace {
  return {
    ...row,
    meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null,
  };
}
