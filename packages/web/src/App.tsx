import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { systemApi } from "./api/client";
import { qk, useEventStream, type StreamStatus } from "./api/events";
import { TriageInbox } from "./views/TriageInbox";
import { Board } from "./views/Board";

type View = "inbox" | "board";

export function App() {
  const [view, setView] = useState<View>("inbox");
  const [stream, setStream] = useState<StreamStatus>({
    connected: false,
    lastEventAt: null,
  });

  useEventStream(setStream);

  const health = useQuery({
    queryKey: qk.health(),
    queryFn: systemApi.health,
    refetchInterval: 30_000,
  });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          tq <span className="brand-sub">triage queue</span>
        </div>
        <nav className="nav">
          <button
            className={view === "inbox" ? "nav-link active" : "nav-link"}
            onClick={() => setView("inbox")}
            data-testid="nav-inbox"
          >
            Triage inbox
          </button>
          <button
            className={view === "board" ? "nav-link active" : "nav-link"}
            onClick={() => setView("board")}
            data-testid="nav-board"
          >
            Board
          </button>
        </nav>
        <div className="ops">
          <span
            className={stream.connected ? "dot dot-ok" : "dot dot-bad"}
            title={stream.connected ? "SSE connected" : "SSE disconnected"}
          />
          {health.data && (
            <span className="ops-jobs" data-testid="jobs-summary">
              {health.data.jobs.running}▶ {health.data.jobs.queued}⏳{" "}
              {health.data.jobs.error}✕
            </span>
          )}
          {health.data && (
            <span
              className={
                health.data.aws.reachable === false ? "aws aws-down" : "aws"
              }
              title="AWS / Bedrock reachability"
            >
              {health.data.aws.reachable === false ? "AWS down" : "AWS"}
            </span>
          )}
        </div>
      </header>

      <main className={view === "board" ? "main main-wide" : "main"}>
        {view === "inbox" ? (
          <TriageInbox />
        ) : (
          <Board />
        )}
      </main>
    </div>
  );
}
