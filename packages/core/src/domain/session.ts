import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import { now } from "./ids.js";
import type { AgentSession, SessionStatus } from "./types.js";

export interface UpsertSessionInput {
  id: string;
  task_id?: string | null;
  workspace_id?: string | null;
  session_file: string;
  cwd: string;
  title?: string | null;
  model?: string | null;
  message_count?: number;
  started_at?: string | null;
  last_activity_at?: string | null;
  status?: SessionStatus;
}

interface SessionRow {
  id: string;
  task_id: string | null;
  workspace_id: string | null;
  session_file: string;
  cwd: string;
  title: string | null;
  model: string | null;
  message_count: number;
  started_at: string | null;
  last_activity_at: string | null;
  status: SessionStatus;
  file_present: number;
  created_at: string;
}

export class SessionRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventBus,
  ) {}

  /**
   * Idempotent upsert keyed by pi session id. Re-emits `session.discovered`
   * for new rows and `session.updated` when content metadata changes.
   */
  upsert(input: UpsertSessionInput): { session: AgentSession; created: boolean } {
    const existing = this.get(input.id);
    const ts = now();
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO agent_session
             (id, task_id, workspace_id, session_file, cwd, title, model,
              message_count, started_at, last_activity_at, status, file_present, created_at)
           VALUES (@id, @task_id, @workspace_id, @session_file, @cwd, @title, @model,
                   @message_count, @started_at, @last_activity_at, @status, 1, @created_at)`,
        )
        .run({
          id: input.id,
          task_id: input.task_id ?? null,
          workspace_id: input.workspace_id ?? null,
          session_file: input.session_file,
          cwd: input.cwd,
          title: input.title ?? null,
          model: input.model ?? null,
          message_count: input.message_count ?? 0,
          started_at: input.started_at ?? null,
          last_activity_at: input.last_activity_at ?? null,
          status: input.status ?? "seen",
          created_at: ts,
        });
      const session = this.get(input.id)!;
      this.bus.emit("session.discovered", session);
      return { session, created: true };
    }

    const changed =
      existing.message_count !== (input.message_count ?? existing.message_count) ||
      existing.last_activity_at !== (input.last_activity_at ?? existing.last_activity_at) ||
      existing.status !== (input.status ?? existing.status) ||
      !existing.file_present;

    this.db
      .prepare(
        `UPDATE agent_session SET
           task_id = COALESCE(@task_id, task_id),
           workspace_id = COALESCE(@workspace_id, workspace_id),
           session_file = @session_file,
           cwd = @cwd,
           title = COALESCE(@title, title),
           model = COALESCE(@model, model),
           message_count = @message_count,
           started_at = COALESCE(@started_at, started_at),
           last_activity_at = @last_activity_at,
           status = @status,
           file_present = 1
         WHERE id = @id`,
      )
      .run({
        id: input.id,
        task_id: input.task_id ?? null,
        workspace_id: input.workspace_id ?? null,
        session_file: input.session_file,
        cwd: input.cwd,
        title: input.title ?? null,
        model: input.model ?? null,
        message_count: input.message_count ?? existing.message_count,
        started_at: input.started_at ?? null,
        last_activity_at: input.last_activity_at ?? existing.last_activity_at,
        status: input.status ?? existing.status,
      });
    const session = this.get(input.id)!;
    if (changed) this.bus.emit("session.updated", session);
    return { session, created: false };
  }

  get(id: string): AgentSession | null {
    const row = this.db.prepare(`SELECT * FROM agent_session WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
    return row ? hydrate(row) : null;
  }

  resolveId(prefix: string): string | null {
    const exact = this.db.prepare(`SELECT id FROM agent_session WHERE id = ?`).get(prefix) as
      | { id: string }
      | undefined;
    if (exact) return exact.id;
    const rows = this.db
      .prepare(`SELECT id FROM agent_session WHERE id LIKE ? LIMIT 2`)
      .all(`${prefix}%`) as { id: string }[];
    return rows.length === 1 ? rows[0]!.id : null;
  }

  listForTask(taskId: string): AgentSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_session WHERE task_id = ?
          ORDER BY (last_activity_at IS NULL), last_activity_at DESC`,
      )
      .all(taskId) as SessionRow[];
    return rows.map(hydrate);
  }

  forWorkspace(workspaceId: string): AgentSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_session WHERE workspace_id = ?
          ORDER BY (last_activity_at IS NULL), last_activity_at DESC`,
      )
      .all(workspaceId) as SessionRow[];
    return rows.map(hydrate);
  }

  /** Files in this workspace that the scan no longer found → tombstone them. */
  markTombstoned(workspaceId: string, presentFiles: string[]): number {
    const rows = this.db
      .prepare(`SELECT id, session_file FROM agent_session WHERE workspace_id = ? AND file_present = 1`)
      .all(workspaceId) as { id: string; session_file: string }[];
    const present = new Set(presentFiles);
    let n = 0;
    for (const r of rows) {
      if (!present.has(r.session_file)) {
        this.db
          .prepare(`UPDATE agent_session SET file_present = 0, status = 'ended' WHERE id = ?`)
          .run(r.id);
        const s = this.get(r.id);
        if (s) this.bus.emit("session.updated", s);
        n++;
      }
    }
    return n;
  }
}

function hydrate(row: SessionRow): AgentSession {
  return { ...row, file_present: row.file_present === 1 };
}
