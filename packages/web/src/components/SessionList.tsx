import type { AgentSession } from "../api/types";

export function SessionList({
  sessions,
  onOpen,
}: {
  sessions: AgentSession[];
  onOpen: (s: AgentSession) => void;
}) {
  if (sessions.length === 0) {
    return <div className="empty">No agent sessions yet. Start one to see it here.</div>;
  }
  return (
    <ul className="session-list" data-testid="session-list">
      {sessions.map((s) => (
        <li
          key={s.id}
          className={`session-row ${s.file_present ? "" : "tombstoned"}`}
          onClick={() => onOpen(s)}
          data-testid="session-row"
        >
          <span className={`session-status session-${s.status}`} title={s.status}>
            {s.status === "active" ? "●" : "○"}
          </span>
          <span className="session-title">{s.title ?? "(untitled session)"}</span>
          <span className="session-meta">
            {s.message_count} msg
            {s.model ? ` · ${s.model}` : ""}
            {s.last_activity_at
              ? ` · ${new Date(s.last_activity_at).toLocaleString()}`
              : ""}
            {!s.file_present ? " · (file gone)" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
