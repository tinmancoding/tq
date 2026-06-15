import { useQuery } from "@tanstack/react-query";
import { sessionApi } from "../api/client";
import { qk } from "../api/events";
import { Modal } from "./Modal";
import type { AgentSession, TriageTraceStep } from "../api/types";

export function SessionTranscript({
  session,
  onClose,
  onResume,
}: {
  session: AgentSession;
  onClose: () => void;
  onResume: (sessionFile: string) => void;
}) {
  const q = useQuery({
    queryKey: qk.transcript(session.id),
    queryFn: () => sessionApi.transcript(session.id),
  });

  return (
    <Modal title={session.title ?? "Session transcript"} onClose={onClose}>
      <div className="transcript-head">
        <span className="detail-id">{session.id.slice(0, 8)}</span>
        {session.model && <span className="badge badge-source">{session.model}</span>}
        {session.file_present && (
          <button
            className="btn btn-primary"
            data-testid="session-resume"
            onClick={() => onResume(session.session_file)}
          >
            Resume
          </button>
        )}
      </div>
      {q.isLoading && <div className="empty">Loading…</div>}
      {q.data && !q.data.file_present && (
        <div className="error-banner">The session file is gone (tombstoned).</div>
      )}
      {q.data && (
        <ol className="transcript" data-testid="transcript">
          {q.data.transcript.map((step, i) => (
            <li key={i} className={`trace trace-${step.kind}`}>
              <TranscriptStep step={step} />
            </li>
          ))}
          {q.data.transcript.length === 0 && <li className="empty">Empty transcript.</li>}
        </ol>
      )}
    </Modal>
  );
}

function TranscriptStep({ step }: { step: TriageTraceStep }) {
  switch (step.kind) {
    case "thought":
      return <div className="trace-thought">{step.text}</div>;
    case "tool_call":
      return (
        <div className="trace-tool">
          <span className="trace-tool-name">→ {step.tool}</span>
          <pre className="trace-args">{JSON.stringify(step.args, null, 2)}</pre>
        </div>
      );
    case "tool_result":
      return (
        <div className={`trace-result ${step.ok ? "" : "trace-error"}`}>
          <span className="trace-tool-name">← {step.tool}</span>
          <pre className="trace-args">{step.text}</pre>
        </div>
      );
    case "error":
      return <div className="trace-error">{step.text}</div>;
  }
}
