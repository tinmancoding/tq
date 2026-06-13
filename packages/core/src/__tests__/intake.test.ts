import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../store.js";
import type { TriageResult } from "../domain/types.js";

function freshStore(): Store {
  return Store.open({ path: ":memory:" });
}

describe("IntakeRepo", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("creates intake and enqueues a triage job", () => {
    const { intake, created } = store.intake.create({ body: "do a thing" });
    expect(created).toBe(true);
    expect(intake.status).toBe("new");
    expect(store.jobs.counts().queued).toBe(1);
  });

  it("is idempotent on (source, event_sig) for pollers", () => {
    const first = store.intake.create({
      source: "github",
      event_sig: "pr:1:opened",
      body: "PR 1",
    });
    const second = store.intake.create({
      source: "github",
      event_sig: "pr:1:opened",
      body: "PR 1 again",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.intake.id).toBe(first.intake.id);
    // Only one job for the single intake.
    expect(store.jobs.counts().queued).toBe(1);
  });

  it("promote carries over triage suggestions into a task", () => {
    const { intake } = store.intake.create({ body: "raw text" });
    const triage: TriageResult = {
      summary: "s",
      category: "bug",
      suggested_title: "Fix the widget",
      suggested_body: "enriched body",
      suggested_labels: [{ key: "project", value: "widget" }],
      suggested_action_verbs: ["fix"],
      suggested_priority: "high",
      refs: [{ kind: "url", url: "https://example.com" }],
      duplicate: { decision: "none" },
      actionable_confidence: 0.9,
      task_count_suggestion: 1,
    };
    store.intake.setTriageResult(intake.id, triage);

    const result = store.intake.promote(intake.id)!;
    const task = store.tasks.get(result.taskId)!;
    expect(task.title).toBe("Fix the widget");
    expect(task.body).toBe("enriched body");
    expect(task.priority).toBe("high");
    expect(task.labels).toContainEqual({ key: "project", value: "widget" });
    expect(task.refs[0]!.url).toBe("https://example.com");
    expect(store.intake.get(intake.id)!.status).toBe("promoted");
    // Provenance worklog + link
    expect(store.intake.linkedTaskIds(intake.id)).toContain(result.taskId);
  });

  it("links intake to an existing task without creating a new one", () => {
    const task = store.tasks.create({ title: "existing" });
    const { intake } = store.intake.create({ body: "dup" });
    store.intake.link(intake.id, task.id);
    expect(store.intake.get(intake.id)!.status).toBe("promoted");
    expect(store.intake.linkedTaskIds(intake.id)).toEqual([task.id]);
    // No extra task created.
    expect(store.tasks.list()).toHaveLength(1);
  });

  it("discard records a reason", () => {
    const { intake } = store.intake.create({ body: "noise" });
    store.intake.discard(intake.id, "noise");
    const got = store.intake.get(intake.id)!;
    expect(got.status).toBe("discarded");
    expect(got.discard_reason).toBe("noise");
  });

  it("retriage requeues a job and resets status", () => {
    const { intake } = store.intake.create({ body: "x" });
    store.intake.setTriageResult(intake.id, fakeTriage());
    expect(store.intake.get(intake.id)!.status).toBe("triaged");
    store.intake.retriage(intake.id);
    expect(store.intake.get(intake.id)!.status).toBe("new");
    expect(store.jobs.counts().queued).toBe(2);
  });
});

function fakeTriage(): TriageResult {
  return {
    summary: "s",
    category: "chore",
    suggested_title: "t",
    suggested_labels: [],
    suggested_action_verbs: [],
    refs: [],
    duplicate: { decision: "none" },
    actionable_confidence: 0.5,
    task_count_suggestion: 1,
  };
}
