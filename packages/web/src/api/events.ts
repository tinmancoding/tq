import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** Query keys, centralized so the SSE hook and views agree. */
export const qk = {
  intakeList: (status?: string) => ["intake", "list", status ?? "all"] as const,
  intake: (id: string) => ["intake", "detail", id] as const,
  taskList: (status?: string) => ["task", "list", status ?? "all"] as const,
  task: (id: string) => ["task", "detail", id] as const,
  health: () => ["system", "health"] as const,
  jobs: () => ["jobs"] as const,
};

// SSE event names the daemon emits (design §8).
const INTAKE_EVENTS = [
  "intake.created",
  "intake.triaged",
  "intake.promoted",
  "intake.discarded",
];
const TASK_EVENTS = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.activity",
];
const JOB_EVENTS = [
  "job.queued",
  "job.started",
  "job.done",
  "job.error",
  "jobs.summary",
  "daemon.status",
];

export interface StreamStatus {
  connected: boolean;
  lastEventAt: number | null;
}

/**
 * Single EventSource against /api/events. Domain events invalidate the
 * relevant TanStack Query caches so views live-update. We invalidate (rather
 * than patch) for correctness first; optimistic patches live in mutations.
 */
export function useEventStream(onStatus?: (s: StreamStatus) => void): void {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/events");

    const invalidate = (keys: readonly (readonly unknown[])[]) => {
      for (const key of keys)
        void qc.invalidateQueries({ queryKey: key as unknown[] });
    };

    const bumpStatus = (connected: boolean) =>
      onStatus?.({ connected, lastEventAt: Date.now() });

    es.onopen = () => bumpStatus(true);
    es.onerror = () => bumpStatus(false);

    for (const name of INTAKE_EVENTS) {
      es.addEventListener(name, (e) => {
        invalidate([["intake", "list"], ["task", "list"], qk.health()]);
        const id = parseId(e);
        if (id) void qc.invalidateQueries({ queryKey: qk.intake(id) });
        bumpStatus(true);
      });
    }

    for (const name of TASK_EVENTS) {
      es.addEventListener(name, (e) => {
        invalidate([["task", "list"], qk.health()]);
        const id = parseId(e);
        if (id) void qc.invalidateQueries({ queryKey: qk.task(id) });
        bumpStatus(true);
      });
    }

    for (const name of JOB_EVENTS) {
      es.addEventListener(name, () => {
        invalidate([qk.jobs(), qk.health()]);
        bumpStatus(true);
      });
    }

    return () => es.close();
  }, [qc, onStatus]);
}

function parseId(e: MessageEvent): string | undefined {
  try {
    const data = JSON.parse(e.data);
    return data?.id ?? data?.intake?.id ?? data?.task?.id ?? data?.task_id;
  } catch {
    return undefined;
  }
}
