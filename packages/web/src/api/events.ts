import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** Query keys, centralized so the SSE hook and views agree. */
export const qk = {
  intakeList: (status?: string) => ["intake", "list", status ?? "all"] as const,
  intake: (id: string) => ["intake", "detail", id] as const,
  taskList: (status?: string) => ["task", "list", status ?? "all"] as const,
  board: () => ["task", "board"] as const,
  task: (id: string) => ["task", "detail", id] as const,
  transcript: (id: string) => ["transcript", id] as const,
  health: () => ["system", "health"] as const,
};

/** The PascalCase domain event types the daemon streams (design Q4 catalog). */
const TASK_EVENTS = [
  "TaskCreated",
  "TaskUpdated",
  "TaskMoved",
  "TaskDeleted",
  "LabelAdded",
  "LabelRemoved",
  "RefAdded",
  "WorkLogged",
  "CommentAdded",
];
const INTAKE_EVENTS = [
  "IntakeCaptured",
  "IntakeStatusChanged",
  "IntakePromoted",
  "IntakeLinked",
];

interface EventEnvelope {
  seq: number;
  type: string;
  scope_type: "task" | "intake" | "global";
  scope_id: string | null;
  payload: unknown;
}

export interface StreamStatus {
  connected: boolean;
  lastEventAt: number | null;
}

/**
 * Single EventSource against the durable /api/events stream. Each message is a
 * domain-event envelope ({seq, type, scope_type, scope_id, payload}); we
 * invalidate the relevant TanStack Query caches by scope. Native EventSource
 * reconnect resends Last-Event-ID, which the daemon treats as the `since`
 * cursor — so a dropped connection resumes without gaps.
 */
export function useEventStream(onStatus?: (s: StreamStatus) => void): void {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/events");

    const bumpStatus = (connected: boolean) =>
      onStatus?.({ connected, lastEventAt: Date.now() });

    const invalidate = (keys: readonly (readonly unknown[])[]) => {
      for (const key of keys) void qc.invalidateQueries({ queryKey: key as unknown[] });
    };

    const handle = (e: MessageEvent) => {
      bumpStatus(true);
      let ev: EventEnvelope;
      try {
        ev = JSON.parse(e.data) as EventEnvelope;
      } catch {
        return;
      }
      if (ev.scope_type === "task") {
        invalidate([["task", "list"], qk.board(), qk.health()]);
        if (ev.scope_id) void qc.invalidateQueries({ queryKey: qk.task(ev.scope_id) });
      } else if (ev.scope_type === "intake") {
        // promote/link affect tasks + board too
        invalidate([["intake", "list"], ["task", "list"], qk.board(), qk.health()]);
        if (ev.scope_id) void qc.invalidateQueries({ queryKey: qk.intake(ev.scope_id) });
      }
    };

    es.onopen = () => bumpStatus(true);
    es.onerror = () => bumpStatus(false);
    for (const name of [...TASK_EVENTS, ...INTAKE_EVENTS, "ContextUpdated"]) {
      es.addEventListener(name, handle as EventListener);
    }
    es.addEventListener("heartbeat", () => {
      invalidate([qk.health()]);
      bumpStatus(true);
    });

    return () => es.close();
  }, [qc, onStatus]);
}
