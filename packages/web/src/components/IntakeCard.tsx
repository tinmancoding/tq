import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { attachmentUrl, intakeApi } from "../api/client";
import { qk } from "../api/events";
import type { DiscardReason, Intake, Label } from "../api/types";

const DISCARD_REASONS: DiscardReason[] = [
  "noise",
  "duplicate",
  "irrelevant",
  "merged",
];

type Mode = "view" | "promote" | "link" | "discard";

export function IntakeCard({ intake }: { intake: Intake }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("view");

  // Full detail: attachments + linked tasks + the (typed) triage result.
  const detail = useQuery({
    queryKey: qk.intake(intake.id),
    queryFn: () => intakeApi.get(intake.id),
  });

  const triage = detail.data?.triage ?? intake.triage;
  const attachments = detail.data?.attachments ?? [];

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["intake", "list"] });
    void qc.invalidateQueries({ queryKey: ["task", "list"] });
    void qc.invalidateQueries({ queryKey: qk.intake(intake.id) });
  };

  const promote = useMutation({
    mutationFn: (payload: Parameters<typeof intakeApi.promote>[1]) =>
      intakeApi.promote(intake.id, payload),
    onSuccess: invalidate,
  });
  const discard = useMutation({
    mutationFn: (reason: string) => intakeApi.discard(intake.id, reason),
    onSuccess: invalidate,
  });
  const retriage = useMutation({
    mutationFn: () => intakeApi.retriage(intake.id),
    onSuccess: invalidate,
  });
  const link = useMutation({
    mutationFn: (taskId: string) => intakeApi.link(intake.id, taskId),
    onSuccess: () => {
      invalidate();
      setMode("view");
    },
  });

  const busy =
    promote.isPending ||
    discard.isPending ||
    retriage.isPending ||
    link.isPending;

  return (
    <article className="card" data-testid="intake-card" data-intake={intake.id}>
      <header className="card-head">
        <span className={`badge badge-${intake.status}`}>{intake.status}</span>
        <span className="badge badge-source">{intake.source}</span>
        {triage?.category && (
          <span className="badge badge-cat">{triage.category}</span>
        )}
        <span className="card-id" title={intake.id}>
          {intake.id.slice(0, 8)}
        </span>
        <span className="card-time">{relTime(intake.created_at)}</span>
      </header>

      {/* AI summary / triage */}
      {intake.status === "new" && (
        <div className="triaging">Triaging… an AI pass is in flight.</div>
      )}
      {intake.triage_error && (
        <div className="error-banner small">
          Triage error: {intake.triage_error}
        </div>
      )}
      {triage && (
        <div className="triage">
          <p className="summary">{triage.summary}</p>
          <ConfidenceBar value={triage.actionable_confidence} />
          {triage.duplicate.decision !== "none" && (
            <DupCandidate
              decision={triage.duplicate.decision}
              taskId={triage.duplicate.task_id}
              reason={triage.duplicate.reason}
            />
          )}
          {triage.suggested_labels.length > 0 && (
            <div className="chips">
              {triage.suggested_labels.map((l, i) => (
                <LabelChip key={i} label={l} />
              ))}
            </div>
          )}
          {triage.suggested_action_verbs.length > 0 && (
            <div className="verbs">
              {triage.suggested_action_verbs.map((v) => (
                <span key={v} className="verb">
                  {v}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Raw captured text */}
      {intake.body && (
        <details className="raw" open={!triage}>
          <summary>Raw capture</summary>
          <pre>{intake.body}</pre>
        </details>
      )}

      {/* Screenshots */}
      {attachments.length > 0 && (
        <div className="shots">
          {attachments.map((a) => (
            <a
              key={a.sha256}
              href={attachmentUrl(a.sha256)}
              target="_blank"
              rel="noreferrer"
            >
              <img src={attachmentUrl(a.sha256)} alt={a.filename ?? "shot"} />
            </a>
          ))}
        </div>
      )}

      {/* Actions */}
      {mode === "view" && (
        <footer className="card-actions">
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => setMode("promote")}
            data-testid="action-promote"
          >
            Promote
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => setMode("link")}
            data-testid="action-link"
          >
            Link
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => setMode("discard")}
            data-testid="action-discard"
          >
            Discard
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => retriage.mutate()}
            data-testid="action-retriage"
          >
            {retriage.isPending ? "Retriaging…" : "Retriage"}
          </button>
        </footer>
      )}

      {mode === "promote" && (
        <PromoteForm
          initialTitle={triage?.suggested_title ?? intake.body?.slice(0, 80) ?? ""}
          initialBody={triage?.suggested_body ?? intake.body ?? ""}
          initialLabels={triage?.suggested_labels ?? []}
          busy={promote.isPending}
          error={promote.error as Error | null}
          onCancel={() => setMode("view")}
          onSubmit={(payload) => promote.mutate(payload)}
        />
      )}

      {mode === "link" && (
        <LinkForm
          busy={link.isPending}
          error={link.error as Error | null}
          suggestedTaskId={
            triage?.duplicate.decision !== "none"
              ? triage?.duplicate.task_id
              : undefined
          }
          onCancel={() => setMode("view")}
          onSubmit={(taskId) => link.mutate(taskId)}
        />
      )}

      {mode === "discard" && (
        <DiscardForm
          busy={discard.isPending}
          onCancel={() => setMode("view")}
          onSubmit={(reason) => {
            discard.mutate(reason);
            setMode("view");
          }}
        />
      )}
    </article>
  );
}

// ─────────────────────────────── sub-components ────────────────────────
function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const cls = value >= 0.8 ? "high" : value >= 0.5 ? "med" : "low";
  return (
    <div className="conf" title={`actionable confidence ${pct}%`}>
      <div className="conf-track">
        <div className={`conf-fill conf-${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="conf-label">{pct}%</span>
    </div>
  );
}

function DupCandidate({
  decision,
  taskId,
  reason,
}: {
  decision: "weak" | "strong";
  taskId?: string;
  reason?: string;
}) {
  return (
    <div className={`dup dup-${decision}`} data-testid="dup-candidate">
      <strong>{decision === "strong" ? "Strong" : "Possible"} duplicate</strong>
      {taskId && <code className="dup-id">{taskId.slice(0, 8)}</code>}
      {reason && <span className="dup-reason"> — {reason}</span>}
    </div>
  );
}

function LabelChip({ label }: { label: Label }) {
  return (
    <span className="chip">
      <span className="chip-k">{label.key}</span>
      <span className="chip-v">{label.value}</span>
    </span>
  );
}

function PromoteForm({
  initialTitle,
  initialBody,
  initialLabels,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  initialTitle: string;
  initialBody: string;
  initialLabels: Label[];
  busy: boolean;
  error: Error | null;
  onCancel: () => void;
  onSubmit: (p: {
    title?: string;
    body?: string | null;
    labels?: Label[];
  }) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [labelsText, setLabelsText] = useState(
    initialLabels.map((l) => `${l.key}:${l.value}`).join(", "),
  );

  return (
    <form
      className="form"
      data-testid="promote-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          title: title.trim() || undefined,
          body: body.trim() || null,
          labels: parseLabels(labelsText),
        });
      }}
    >
      <label className="field">
        <span>Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="promote-title"
          autoFocus
        />
      </label>
      <label className="field">
        <span>Body</span>
        <textarea
          value={body}
          rows={4}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Labels (key:value, comma-separated)</span>
        <input
          value={labelsText}
          onChange={(e) => setLabelsText(e.target.value)}
          placeholder="project:tq, area:ui"
        />
      </label>
      {error && <div className="error-banner small">{error.message}</div>}
      <div className="form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy}
          data-testid="promote-submit"
        >
          {busy ? "Creating…" : "Create task"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function LinkForm({
  busy,
  error,
  suggestedTaskId,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: Error | null;
  suggestedTaskId?: string;
  onCancel: () => void;
  onSubmit: (taskId: string) => void;
}) {
  const [taskId, setTaskId] = useState(suggestedTaskId ?? "");
  return (
    <form
      className="form"
      data-testid="link-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (taskId.trim()) onSubmit(taskId.trim());
      }}
    >
      <label className="field">
        <span>Existing task id (or prefix)</span>
        <input
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          placeholder="019ec27f…"
          autoFocus
        />
      </label>
      {error && <div className="error-banner small">{error.message}</div>}
      <div className="form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !taskId.trim()}
        >
          {busy ? "Linking…" : "Link"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DiscardForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState<DiscardReason>("noise");
  return (
    <form
      className="form"
      data-testid="discard-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason);
      }}
    >
      <label className="field">
        <span>Reason</span>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as DiscardReason)}
        >
          {DISCARD_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn btn-danger" disabled={busy}>
          Discard
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────────── helpers ──────────────────────────────
function parseLabels(text: string): Label[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx === -1) return null;
      return { key: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
    })
    .filter((l): l is Label => !!l && !!l.key && !!l.value);
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
