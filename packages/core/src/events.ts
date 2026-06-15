import { EventEmitter } from "node:events";

/** Names of domain events emitted across tq (mirrors design §8). */
export type TqEventName =
  | "intake.created"
  | "intake.triaged"
  | "intake.promoted"
  | "intake.discarded"
  | "task.created"
  | "task.updated"
  | "task.moved"
  | "task.activity"
  | "job.queued"
  | "job.started"
  | "job.done"
  | "job.error"
  | "jobs.summary"
  | "watchlist.polled"
  | "daemon.status";

export interface TqEvent {
  event: TqEventName;
  data: unknown;
}

/**
 * Process-local pub/sub. The daemon subscribes and fans events out over SSE;
 * repos publish after successful writes.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many SSE clients + internal listeners; lift the default cap.
    this.emitter.setMaxListeners(0);
  }

  emit(event: TqEventName, data: unknown): void {
    this.emitter.emit("event", { event, data } satisfies TqEvent);
  }

  subscribe(fn: (e: TqEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}
