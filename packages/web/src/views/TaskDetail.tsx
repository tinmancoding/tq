import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { taskApi, workspaceApi, sessionApi } from "../api/client";
import { qk } from "../api/events";
import { navigate } from "../api/router";
import { CreateWorkspaceModal } from "../components/CreateWorkspaceModal";
import { SessionList } from "../components/SessionList";
import { SessionTranscript } from "../components/SessionTranscript";
import {
  PRIORITIES,
  TASK_STATUSES,
  type Activity,
  type AgentSession,
  type Label,
  type Priority,
  type TaskStatus,
  type Workspace,
} from "../api/types";

const PRIORITY_OPTS = ["", ...PRIORITIES] as const;

export function TaskDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const task = useQuery({
    queryKey: qk.task(id),
    queryFn: () => taskApi.get(id),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.task(id) });
    void qc.invalidateQueries({ queryKey: qk.board() });
    void qc.invalidateQueries({ queryKey: ["task", "list"] });
  };

  const patch = useMutation({
    mutationFn: (p: Parameters<typeof taskApi.update>[1]) => taskApi.update(id, p),
    onSuccess: invalidate,
  });
  const move = useMutation({
    mutationFn: (status: TaskStatus) => taskApi.move(id, status),
    onSuccess: invalidate,
  });
  const addLabel = useMutation({
    mutationFn: (l: Label) => taskApi.addLabel(id, l),
    onSuccess: invalidate,
  });
  const removeLabel = useMutation({
    mutationFn: (l: Label) => taskApi.removeLabel(id, l),
    onSuccess: invalidate,
  });
  const addRef = useMutation({
    mutationFn: (r: { kind: string; url: string }) => taskApi.addRef(id, r),
    onSuccess: invalidate,
  });
  const addActivity = useMutation({
    mutationFn: (e: { entry_type: "worklog" | "comment"; body: string }) =>
      taskApi.addActivity(id, e),
    onSuccess: invalidate,
  });

  if (task.isLoading) return <div className="empty">Loading…</div>;
  if (task.error || !task.data) {
    return (
      <div className="error-banner">
        Task not found: {(task.error as Error)?.message ?? id}
      </div>
    );
  }
  const t = task.data;

  return (
    <section className="detail">
      <button className="back" onClick={() => navigate("/board")}>
        ← Board
      </button>

      <EditableTitle
        value={t.title}
        onSave={(title) => patch.mutate({ title })}
      />

      <div className="detail-controls">
        <label className="field inline">
          <span>Status</span>
          <select
            value={t.status}
            data-testid="detail-status"
            onChange={(e) => move.mutate(e.target.value as TaskStatus)}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>Priority</span>
          <select
            value={t.priority ?? ""}
            data-testid="detail-priority"
            onChange={(e) =>
              patch.mutate({ priority: (e.target.value || null) as Priority | null })
            }
          >
            {PRIORITY_OPTS.map((p) => (
              <option key={p} value={p}>
                {p || "—"}
              </option>
            ))}
          </select>
        </label>
        <span className="detail-id">{t.id.slice(0, 8)}</span>
      </div>

      <EditableBody value={t.body ?? ""} onSave={(body) => patch.mutate({ body: body || null })} />

      <Labels
        labels={t.labels}
        onAdd={(l) => addLabel.mutate(l)}
        onRemove={(l) => removeLabel.mutate(l)}
      />

      <Refs refs={t.refs} onAdd={(r) => addRef.mutate(r)} />

      <WorkspaceSection taskId={id} />

      {t.linked_intakes.length > 0 && (
        <div className="block">
          <h3>Linked intakes</h3>
          <ul className="linked">
            {t.linked_intakes.map((li) => (
              <li key={li.id}>
                <span className="badge badge-source">{li.relation}</span>
                <code>{li.id.slice(0, 8)}</code>
                <span className="linked-summary">{li.summary ?? "—"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Timeline
        activity={t.activity}
        onAdd={(e) => addActivity.mutate(e)}
        busy={addActivity.isPending}
      />
    </section>
  );
}

// ──────────────────────────── workspace + sessions ────────────────────
function WorkspaceSection({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [openSession, setOpenSession] = useState<AgentSession | null>(null);

  const ws = useQuery({
    queryKey: qk.workspace(taskId),
    queryFn: () => workspaceApi.get(taskId),
    retry: false,
  });
  const hasWorkspace = ws.data && (ws.error == null);

  const sessions = useQuery({
    queryKey: qk.sessions(taskId),
    queryFn: () => sessionApi.list(taskId),
    enabled: !!hasWorkspace && ws.data?.status === "ready",
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.workspace(taskId) });
    void qc.invalidateQueries({ queryKey: qk.sessions(taskId) });
  };

  const create = useMutation({
    mutationFn: (input: { provider: string; name: string; template?: string }) =>
      workspaceApi.create(taskId, input),
    onSuccess: () => {
      setShowCreate(false);
      invalidate();
    },
  });
  const detach = useMutation({
    mutationFn: () => workspaceApi.detach(taskId),
    onSuccess: invalidate,
  });
  const start = useMutation({
    mutationFn: (sessionFile?: string) => sessionApi.start(taskId, sessionFile),
    onSuccess: (res) => {
      if (!res.launched) window.prompt("Run this command to start a session:", res.command);
      invalidate();
    },
  });

  const w: Workspace | undefined = hasWorkspace ? ws.data : undefined;

  return (
    <div className="block" data-testid="workspace-section">
      <h3>Workspace</h3>
      {!w && (
        <div className="ws-empty">
          <button className="btn btn-primary" onClick={() => setShowCreate(true)} data-testid="ws-create">
            Create tasktree…
          </button>
        </div>
      )}
      {w && w.status === "provisioning" && (
        <div className="ws-provisioning" data-testid="ws-provisioning">
          <span className="spinner" /> Provisioning {w.name}…
        </div>
      )}
      {w && w.status === "error" && (
        <div className="error-banner">Workspace error: {w.error ?? "unknown"}</div>
      )}
      {w && w.status === "ready" && (
        <div className="ws-ready" data-testid="ws-ready">
          <div className="ws-meta">
            <span className="badge badge-source">{w.provider}</span>
            <code className="ws-path">{w.root_path}</code>
          </div>
          <div className="ws-actions">
            <button className="btn btn-primary" onClick={() => start.mutate(undefined)} data-testid="ws-start">
              Start session
            </button>
            <button className="btn" onClick={() => detach.mutate()}>
              Detach
            </button>
          </div>
          <h4>Sessions</h4>
          <SessionList sessions={sessions.data ?? []} onOpen={setOpenSession} />
        </div>
      )}

      {showCreate && (
        <CreateWorkspaceModal
          defaultName={taskId.slice(0, 8)}
          onClose={() => setShowCreate(false)}
          onCreate={(input) => create.mutate(input)}
        />
      )}
      {openSession && (
        <SessionTranscript
          session={openSession}
          onClose={() => setOpenSession(null)}
          onResume={(file) => {
            start.mutate(file);
            setOpenSession(null);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────── editable fields ──────────────────────
function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing)
    return (
      <h1 className="detail-title" onClick={() => setEditing(true)} data-testid="detail-title">
        {value}
      </h1>
    );
  return (
    <input
      className="detail-title-input"
      data-testid="detail-title-input"
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft.trim() && draft !== value) onSave(draft.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}

function EditableBody({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="block">
      <h3>Body</h3>
      <textarea
        className="detail-body"
        data-testid="detail-body"
        rows={5}
        value={draft}
        placeholder="Markdown body…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onSave(draft);
        }}
      />
    </div>
  );
}

function Labels({
  labels,
  onAdd,
  onRemove,
}: {
  labels: Label[];
  onAdd: (l: Label) => void;
  onRemove: (l: Label) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="block">
      <h3>Labels</h3>
      <div className="chips">
        {labels.map((l, i) => (
          <span key={i} className="chip">
            <span className="chip-k">{l.key}</span>
            <span className="chip-v">{l.value}</span>
            <button className="chip-x" onClick={() => onRemove(l)} aria-label="remove label">
              ×
            </button>
          </span>
        ))}
      </div>
      <form
        className="inline-add"
        onSubmit={(e) => {
          e.preventDefault();
          const idx = text.indexOf(":");
          if (idx > 0) {
            onAdd({ key: text.slice(0, idx).trim(), value: text.slice(idx + 1).trim() });
            setText("");
          }
        }}
      >
        <input
          value={text}
          placeholder="key:value"
          data-testid="label-input"
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn" type="submit">
          Add
        </button>
      </form>
    </div>
  );
}

function Refs({
  refs,
  onAdd,
}: {
  refs: { id: string; kind: string; url: string; external_id: string | null }[];
  onAdd: (r: { kind: string; url: string }) => void;
}) {
  const [kind, setKind] = useState("url");
  const [url, setUrl] = useState("");
  return (
    <div className="block">
      <h3>References</h3>
      <ul className="refs">
        {refs.map((r) => (
          <li key={r.id}>
            <span className="badge badge-source">{r.kind}</span>
            <a href={r.url} target="_blank" rel="noreferrer">
              {r.url}
            </a>
          </li>
        ))}
      </ul>
      <form
        className="inline-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) {
            onAdd({ kind: kind.trim() || "url", url: url.trim() });
            setUrl("");
          }
        }}
      >
        <input
          value={kind}
          className="ref-kind"
          onChange={(e) => setKind(e.target.value)}
          placeholder="kind"
        />
        <input
          value={url}
          placeholder="https://…"
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn" type="submit">
          Add
        </button>
      </form>
    </div>
  );
}

function Timeline({
  activity,
  onAdd,
  busy,
}: {
  activity: Activity[];
  onAdd: (e: { entry_type: "worklog" | "comment"; body: string }) => void;
  busy: boolean;
}) {
  const [entryType, setEntryType] = useState<"worklog" | "comment">("comment");
  const [body, setBody] = useState("");
  return (
    <div className="block">
      <h3>Activity</h3>
      <form
        className="activity-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) {
            onAdd({ entry_type: entryType, body: body.trim() });
            setBody("");
          }
        }}
      >
        <select
          value={entryType}
          onChange={(e) => setEntryType(e.target.value as "worklog" | "comment")}
        >
          <option value="comment">comment</option>
          <option value="worklog">worklog</option>
        </select>
        <input
          value={body}
          placeholder="Add a note…"
          data-testid="activity-input"
          onChange={(e) => setBody(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy} data-testid="activity-submit">
          Add
        </button>
      </form>
      <ul className="timeline" data-testid="timeline">
        {[...activity].reverse().map((a) => (
          <li key={a.id} className={`tl tl-${a.entry_type}`}>
            <div className="tl-head">
              <span className="tl-type">{a.entry_type}</span>
              <span className="tl-actor">{a.actor}</span>
              <span className="tl-time">{new Date(a.created_at).toLocaleString()}</span>
            </div>
            <div className="tl-body">{a.body}</div>
          </li>
        ))}
        {activity.length === 0 && <li className="empty">No activity yet.</li>}
      </ul>
    </div>
  );
}
