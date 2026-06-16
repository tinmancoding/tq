import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../store.js";

function freshStore(): Store {
  return Store.open({ path: ":memory:" });
}

describe("SubscriptionRepo (Phase D)", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("registers idempotently and starts at cursor 0", () => {
    const a = store.subscriptions.register("triage", { types: ["IntakeCaptured"], scope: "intake" } as never);
    expect(a.cursor).toBe(0);
    const again = store.subscriptions.register("triage");
    expect(again.consumer_id).toBe("triage");
    expect(store.subscriptions.list()).toHaveLength(1);
  });

  it("commits the cursor forward-only and reports lag", () => {
    store.subscriptions.register("search");
    store.tasks.create({ title: "a" });
    store.tasks.create({ title: "b" });
    const head = store.events.maxSeq();
    expect(store.subscriptions.lag("search", head)).toBe(head); // cursor 0

    store.subscriptions.commit("search", head);
    expect(store.subscriptions.lag("search", head)).toBe(0);

    // forward-only: a stale commit can't move it backwards
    store.subscriptions.commit("search", 1);
    expect(store.subscriptions.get("search")!.cursor).toBe(head);
  });

  it("records dead-letters (capped) with seq + error", () => {
    store.subscriptions.register("triage");
    store.subscriptions.recordDeadLetter("triage", 42, "boom");
    const sub = store.subscriptions.get("triage")!;
    expect(sub.dead_letters).toHaveLength(1);
    expect(sub.dead_letters[0]).toMatchObject({ seq: 42, error: "boom" });
  });

  it("lag for an unknown consumer is the full head", () => {
    expect(store.subscriptions.lag("ghost", 7)).toBe(7);
  });
});
