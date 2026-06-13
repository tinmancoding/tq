import type { Store } from "../store.js";
import { now } from "../domain/ids.js";
import { isVecAvailable, upsertTaskVector } from "./vector.js";
import { taskEmbeddingText, type Embedder } from "./embeddings.js";

export interface EmbeddingWorkerOptions {
  /** How often to drain the queue when idle (ms). */
  pollIntervalMs?: number;
  /** Seconds to wait after a failure before retrying the drain. */
  errorBackoffMs?: number;
}

/**
 * Drains the `embedding_queue`: embeds each task's text and upserts it into the
 * vector index. When AWS is unreachable the embed call throws; the task stays
 * queued and the worker backs off, resuming when connectivity returns.
 */
export class EmbeddingWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(
    private readonly store: Store,
    private readonly embedder: Embedder,
    private readonly opts: EmbeddingWorkerOptions = {},
  ) {}

  start(): void {
    if (!isVecAvailable(this.store.db)) return; // nothing to do without vec
    this.stopped = false;
    this.unsub = this.store.bus.subscribe((e) => {
      if (e.event === "task.created" || e.event === "task.updated") void this.drain();
    });
    this.timer = setInterval(() => void this.drain(), this.opts.pollIntervalMs ?? 5000);
    void this.drain();
  }

  private unsub: (() => void) | null = null;

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsub?.();
    this.unsub = null;
  }

  /** Embed and index every queued task. Resolves when the queue is drained. */
  async drain(): Promise<void> {
    if (this.running || !isVecAvailable(this.store.db)) return;
    this.running = true;
    try {
      for (;;) {
        const row = this.store.db
          .prepare(`SELECT task_id FROM embedding_queue ORDER BY enqueued_at LIMIT 1`)
          .get() as { task_id: string } | undefined;
        if (!row) break;
        const task = this.store.tasks.get(row.task_id);
        if (!task) {
          // Task gone; drop the orphaned queue entry.
          this.store.db.prepare(`DELETE FROM embedding_queue WHERE task_id = ?`).run(row.task_id);
          continue;
        }
        const embedding = await this.embedder.embed(taskEmbeddingText(task.title, task.body));
        upsertTaskVector(this.store.db, task.id, embedding);
        this.store.db.prepare(`DELETE FROM embedding_queue WHERE task_id = ?`).run(task.id);
      }
    } catch {
      // Leave remaining items queued; a later tick retries.
      void now();
    } finally {
      this.running = false;
    }
  }

  /** Count of tasks still awaiting embedding. */
  pending(): number {
    return (this.store.db.prepare(`SELECT COUNT(*) AS n FROM embedding_queue`).get() as { n: number }).n;
  }
}
