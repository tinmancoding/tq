import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../store.js";
import { isVecAvailable } from "../search/vector.js";
import { EmbeddingWorker } from "../search/embedding-worker.js";
import { search } from "../search/hybrid.js";
import type { Embedder } from "../search/embeddings.js";

// Tiny deterministic bag-of-words embedder over a fixed vocabulary.
const VOCAB = ["auth", "cookie", "login", "search", "rate", "limit", "ui", "button"];
class BowEmbedder implements Embedder {
  readonly dims = VOCAB.length;
  calls = 0;
  async embed(text: string): Promise<number[]> {
    this.calls++;
    const lower = text.toLowerCase();
    return VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
  }
}

describe("vector + hybrid search", () => {
  let store: Store;
  beforeEach(() => {
    store = Store.open({ path: ":memory:", embeddingDims: VOCAB.length });
  });

  it("loads sqlite-vec in tests", () => {
    expect(isVecAvailable(store.db)).toBe(true);
  });

  it("enqueues tasks for embedding and the worker drains them", async () => {
    store.tasks.create({ title: "Fix auth cookie login bug" });
    store.tasks.create({ title: "Add rate limit to search" });
    const worker = new EmbeddingWorker(store, new BowEmbedder());
    expect(worker.pending()).toBe(2);
    await worker.drain();
    expect(worker.pending()).toBe(0);
  });

  it("fuses vector + fts and flags vector:true", async () => {
    const embedder = new BowEmbedder();
    const auth = store.tasks.create({ title: "Investigate auth cookie expiry" });
    store.tasks.create({ title: "Redesign the settings button" });
    await new EmbeddingWorker(store, embedder).drain();

    // Query shares vocabulary with the auth task via the vector signal.
    const res = await search(store.db, store.tasks, "login cookie", {}, embedder);
    expect(res.vector).toBe(true);
    expect(res.hits[0]!.task.id).toBe(auth.id);
    expect(res.hits[0]!.signals.vector).toBe(true);
  });

  it("falls back to fts-only when no embedder is supplied", async () => {
    store.tasks.create({ title: "Fix the login flow" });
    const res = await search(store.db, store.tasks, "login");
    expect(res.vector).toBe(false);
    expect(res.hits).toHaveLength(1);
  });

  it("degrades gracefully when embedding the query throws", async () => {
    store.tasks.create({ title: "Fix the login flow" });
    const flaky: Embedder = {
      dims: VOCAB.length,
      async embed() {
        throw new Error("AWS down");
      },
    };
    const res = await search(store.db, store.tasks, "login", {}, flaky);
    expect(res.vector).toBe(false); // vector signal skipped
    expect(res.hits).toHaveLength(1); // fts still works
  });
});
