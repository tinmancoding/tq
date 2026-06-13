import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../store.js";
import { TriageWorkerPool } from "../triage/worker.js";
import type { TriageEngine, TriageInput, TriageSearchFn } from "../triage/engine.js";
import type { TriageResult } from "../domain/types.js";

function fresh(): Store {
  return Store.open({ path: ":memory:" });
}

function triageResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    summary: "s",
    category: "bug",
    suggested_title: "Auto title",
    suggested_body: "auto body",
    suggested_labels: [{ key: "area", value: "auth" }],
    suggested_action_verbs: ["fix"],
    suggested_priority: "med",
    refs: [],
    duplicate: { decision: "none" },
    actionable_confidence: 0.95,
    task_count_suggestion: 1,
    ...overrides,
  };
}

/** Engine that returns a fixed result and records what it saw. */
class MockEngine implements TriageEngine {
  lastInput?: TriageInput;
  searchCalls: string[] = [];
  constructor(private readonly result: TriageResult | (() => TriageResult)) {}
  async triage(input: TriageInput, searchTasks: TriageSearchFn): Promise<TriageResult> {
    this.lastInput = input;
    searchTasks("probe", 5); // exercise the tool wiring
    this.searchCalls.push(input.intake.id);
    return typeof this.result === "function" ? this.result() : this.result;
  }
}

const opts = { concurrency: 2, maxAttempts: 3, autoCreateConfidence: 0.8, pollIntervalMs: 5 };

describe("TriageWorkerPool", () => {
  let store: Store;
  beforeEach(() => {
    store = fresh();
  });

  it("auto-creates a task for a confident, non-duplicate intake", async () => {
    const { intake } = store.intake.create({ body: "please fix the login flow" });
    const pool = new TriageWorkerPool(store, new MockEngine(triageResult()), opts);
    await pool.drain();
    pool.stop();

    const after = store.intake.get(intake.id)!;
    expect(after.status).toBe("promoted");
    const taskIds = store.intake.linkedTaskIds(intake.id);
    expect(taskIds).toHaveLength(1);
    const task = store.tasks.get(taskIds[0]!)!;
    expect(task.title).toBe("Auto title");
    expect(task.created_by).toBe("agent:triage");
    expect(task.status).toBe("backlog");
    expect(store.jobs.counts().done).toBe(1);
  });

  it("leaves low-confidence intake in triaged for review", async () => {
    const { intake } = store.intake.create({ body: "vague idea" });
    const pool = new TriageWorkerPool(
      store,
      new MockEngine(triageResult({ actionable_confidence: 0.3 })),
      opts,
    );
    await pool.drain();
    pool.stop();

    expect(store.intake.get(intake.id)!.status).toBe("triaged");
    expect(store.tasks.list()).toHaveLength(0);
  });

  it("auto-links a strong duplicate to the existing task", async () => {
    const existing = store.tasks.create({ title: "Existing auth task" });
    const { intake } = store.intake.create({ body: "dup of auth" });
    const pool = new TriageWorkerPool(
      store,
      new MockEngine(triageResult({ duplicate: { decision: "strong", task_id: existing.id } })),
      opts,
    );
    await pool.drain();
    pool.stop();

    expect(store.intake.get(intake.id)!.status).toBe("promoted");
    expect(store.intake.linkedTaskIds(intake.id)).toEqual([existing.id]);
    expect(store.tasks.list()).toHaveLength(1); // no new task
  });

  it("retries with backoff then errors after max attempts", async () => {
    const { intake } = store.intake.create({ body: "boom" });
    const engine: TriageEngine = {
      async triage() {
        throw new Error("bedrock unavailable");
      },
    };
    // backoffBaseSec 0 → immediate retries so the test runs fast.
    const pool = new TriageWorkerPool(store, engine, { ...opts, backoffBaseSec: 0 });
    await pool.drain();
    pool.stop();

    const counts = store.jobs.counts();
    expect(counts.error).toBe(1);
    const job = store.jobs.list()[0]!;
    expect(job.attempts).toBe(3);
    expect(job.last_error).toContain("bedrock unavailable");
    expect(store.intake.get(intake.id)!.triage_error).toContain("bedrock unavailable");
  });

  it("passes images and a working search function to the engine", async () => {
    store.tasks.create({ title: "searchable cookie task" });
    const { intake } = store.intake.create({ body: "x" });
    const engine = new MockEngine(triageResult());
    const pool = new TriageWorkerPool(store, engine, {
      ...opts,
      loadImages: () => [{ mediaType: "image/png", dataBase64: "AAAA" }],
    });
    await pool.drain();
    pool.stop();
    expect(engine.lastInput?.images).toHaveLength(1);
    expect(engine.searchCalls).toContain(intake.id);
  });
});
