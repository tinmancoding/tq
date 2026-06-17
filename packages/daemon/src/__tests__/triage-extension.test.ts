import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, defaultConfig, type TqConfig } from "@tq/core";
import type { TriageResult } from "@tq/contract";
import {
  triageExtension,
  type TriageEngine,
  type TriageInput,
  type TriageInjected,
} from "@tq/ext-triage";
import { buildServer, type TqServer } from "../server.js";

function injectFetch(getApp: () => TqServer): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const res = await getApp().inject({
      method: (init?.method ?? "GET") as never,
      url: u.pathname + u.search,
      headers: (init?.headers as Record<string, string>) ?? {},
      payload: init?.body as string | undefined,
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: { "content-type": res.headers["content-type"]?.toString() ?? "application/json" },
    });
  }) as typeof fetch;
}

function result(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    summary: "a summary",
    category: "bug",
    suggested_title: "Fix the login bug",
    suggested_body: "enriched body",
    suggested_labels: [{ key: "project", value: "auth" }],
    suggested_action_verbs: ["fix"],
    suggested_priority: "high",
    refs: [],
    duplicate: { decision: "none" },
    actionable_confidence: 0.9,
    task_count_suggestion: 1,
    ...overrides,
  };
}

/** Deterministic engine standing in for the Bedrock LLM. */
class FakeEngine implements TriageEngine {
  calls = 0;
  searched = 0;
  constructor(
    private readonly out: TriageResult | (() => Promise<TriageResult>),
  ) {}
  async triage(_input: TriageInput, injected: TriageInjected): Promise<TriageResult> {
    this.calls++;
    await injected.searchTasks("login", 5); // exercise the public /api/search path
    this.searched++;
    return typeof this.out === "function" ? this.out() : this.out;
  }
}

function cfg(): TqConfig {
  return { ...defaultConfig(), extensions: { triage: { enabled: true } } };
}

describe("triage as an extension (Phase G proof)", () => {
  let store: Store;
  let server: TqServer;

  beforeEach(() => {
    store = Store.open({ path: ":memory:", attachmentsDir: mkdtempSync(join(tmpdir(), "tq-trex-")) });
  });
  afterEach(async () => {
    server.tqExtensionHost.stop();
    await server.close();
    store.close();
  });

  async function boot(engine: TriageEngine): Promise<void> {
    server = buildServer({
      store,
      config: cfg(),
      extensions: [triageExtension({ engine, autoCreateConfidence: 0.8 })],
      coreFetch: injectFetch(() => server),
    });
    server.tqExtensionHost.start();
  }

  it("IntakeCaptured → runs engine, writes context.triage, gate auto-creates a task", async () => {
    const engine = new FakeEngine(result());
    await boot(engine);

    const cap = await server.inject({ method: "POST", url: "/api/intake", payload: { text: "login broken" } });
    const intakeId = cap.json().id as string;
    await server.tqExtensionHost.idle();

    expect(engine.calls).toBe(1);
    expect(engine.searched).toBe(1);

    // Triage result landed in the context bag via the public API.
    const triage = store.context.get("intake", intakeId)!.triage as TriageResult;
    expect(triage.suggested_title).toBe("Fix the login bug");

    // Gate auto-created a task (confidence 0.9 ≥ 0.8, no duplicate) and promoted.
    expect(store.intake.get(intakeId)!.status).toBe("promoted");
    const task = store.tasks.list().find((t) => t.title === "Fix the login bug")!;
    expect(task).toBeTruthy();
    expect(task.priority).toBe("high");
    expect(task.body).toBe("enriched body");
  });

  it("low-confidence → gate leaves it for manual review (triaged)", async () => {
    await boot(new FakeEngine(result({ actionable_confidence: 0.2 })));
    const cap = await server.inject({ method: "POST", url: "/api/intake", payload: { text: "vague idea" } });
    const id = cap.json().id as string;
    await server.tqExtensionHost.idle();

    expect(store.intake.get(id)!.status).toBe("triaged");
    expect(store.tasks.list()).toHaveLength(0);
  });

  it("redelivery is idempotent: an already-triaged intake is skipped", async () => {
    const engine = new FakeEngine(result({ actionable_confidence: 0.2 }));
    await boot(engine);
    const cap = await server.inject({ method: "POST", url: "/api/intake", payload: { text: "once" } });
    const id = cap.json().id as string;
    await server.tqExtensionHost.idle();
    expect(engine.calls).toBe(1);

    // Re-emit IntakeCaptured for the same (now triaged) intake.
    store.intake.queueTriage(id);
    await server.tqExtensionHost.idle();
    expect(engine.calls).toBe(1); // guard skipped it
  });

  it("engine failure leaves the intake `new` with a recorded error (no throw → no dead-letter)", async () => {
    await boot(
      new FakeEngine(() => Promise.reject(new Error("bedrock throttled"))),
    );
    const cap = await server.inject({ method: "POST", url: "/api/intake", payload: { text: "will fail" } });
    const id = cap.json().id as string;
    await server.tqExtensionHost.idle();

    expect(store.intake.get(id)!.status).toBe("new");
    expect(store.context.get("intake", id)!.triage_error).toBe("bedrock throttled");
    // Not dead-lettered: the handler swallowed the error so retriage can resume.
    expect(store.subscriptions.get("triage")!.dead_letters).toHaveLength(0);
  });

  it("pass_timeout_ms: a never-resolving engine trips the timeout, leaves intake 'new' with error persisted (Phase E)", async () => {
    // Never-resolving stub — simulates a hung LLM session.
    const hungEngine: TriageEngine = {
      triage(): Promise<TriageResult> {
        return new Promise(() => {
          /* intentionally never resolves */
        });
      },
    };

    // Boot with a very short timeout so the test completes in milliseconds.
    server = buildServer({
      store,
      config: cfg(),
      extensions: [
        triageExtension({
          engine: hungEngine,
          autoCreateConfidence: 0.8,
          passTimeoutMs: 50, // trip immediately in test
        }),
      ],
      coreFetch: injectFetch(() => server),
    });
    server.tqExtensionHost.start();

    const cap = await server.inject({
      method: "POST",
      url: "/api/intake",
      payload: { text: "test abort" },
    });
    const id = cap.json().id as string;
    await server.tqExtensionHost.idle();

    // Intake must remain 'new' (not dead-lettered or stuck in limbo)
    expect(store.intake.get(id)!.status).toBe("new");
    // Error must be persisted for debugging
    const errMsg = store.context.get("intake", id)!.triage_error as string;
    expect(errMsg).toMatch(/timed out/i);
    // Not dead-lettered — the catch path swallowed the error
    expect(store.subscriptions.get("triage")!.dead_letters).toHaveLength(0);
  });
});
