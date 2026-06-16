import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";

function freshStore(contextSpillBytes?: number): Store {
  return Store.open({
    path: ":memory:",
    attachmentsDir: mkdtempSync(join(tmpdir(), "tq-ctx-")),
    contextSpillBytes,
  });
}

describe("ContextRepo (Phase C)", () => {
  let store: Store;
  beforeEach(() => {
    store = freshStore();
  });

  it("sets a namespace slot and surfaces it inline on the entity", () => {
    const t = store.tasks.create({ title: "T" });
    store.context.set("task", t.id, "triage", { summary: "looks like a bug" }, "agent:triage");

    expect(store.context.get("task", t.id)).toEqual({ triage: { summary: "looks like a bug" } });
    // inline on the read model
    expect(store.tasks.get(t.id)!.context).toEqual({ triage: { summary: "looks like a bug" } });
  });

  it("replaces only its own namespace — no clobber across extensions", () => {
    const t = store.tasks.create({ title: "T" });
    store.context.set("task", t.id, "triage", { v: 1 }, "agent:triage");
    store.context.set("task", t.id, "search", { indexed: true }, "agent:search");
    store.context.set("task", t.id, "triage", { v: 2 }, "agent:triage"); // replace own slot

    expect(store.context.get("task", t.id)).toEqual({
      triage: { v: 2 },
      search: { indexed: true },
    });
  });

  it("emits a ContextUpdated event per set", () => {
    const t = store.tasks.create({ title: "T" });
    const head = store.events.maxSeq();
    store.context.set("task", t.id, "triage", { ok: true }, "agent:triage");
    const evs = store.events.read({ since: head });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "ContextUpdated",
      scope_type: "task",
      scope_id: t.id,
      actor: "agent:triage",
    });
    expect(evs[0]!.payload).toMatchObject({ namespace: "triage", value: { ok: true } });
  });

  it("claim-checks oversized values: stores a $ref, resolvable from the blob store", () => {
    store = freshStore(64); // tiny threshold to force spill
    const t = store.tasks.create({ title: "T" });
    const big = { blob: "x".repeat(500) };
    const res = store.context.set("task", t.id, "triage", big, "agent:triage");

    expect(res!.spilled).toBe(true);
    const slot = store.context.get("task", t.id)!.triage as { $ref: string; bytes: number };
    expect(slot.$ref).toMatch(/^blob:sha256:[0-9a-f]{64}$/);
    expect(slot.bytes).toBeGreaterThan(64);

    // the spilled bytes round-trip from the content-addressed store
    const sha = slot.$ref.split(":")[2]!;
    const b64 = store.attachments.readBase64(sha)!;
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))).toEqual(big);
  });

  it("small values stay inline (no spill)", () => {
    store = freshStore(64);
    const t = store.tasks.create({ title: "T" });
    const res = store.context.set("task", t.id, "triage", { small: 1 }, "agent:triage");
    expect(res!.spilled).toBe(false);
    expect(store.context.get("task", t.id)).toEqual({ triage: { small: 1 } });
  });

  it("returns null for a missing entity", () => {
    expect(store.context.set("task", "nope", "triage", {}, "a")).toBeNull();
    expect(store.context.get("intake", "nope")).toBeNull();
  });
});
