import { describe, it, expect, beforeEach } from "vitest";
import { Store, WorkspaceConflictError } from "@tq/core";
import { WorkspaceService } from "../workspace/service.js";
import { ProviderRegistry } from "../workspace/registry.js";
import type {
  WorkspaceProvider,
  ProviderWorkspaceRef,
  CreateWorkspaceOpts,
  WorkspaceInfo,
} from "@tq/core";

/** A fully in-memory fake provider that records tag/annotation calls. */
class FakeProvider implements WorkspaceProvider {
  readonly name = "fake";
  tagged: Record<string, string>[] = [];
  discoverable: ProviderWorkspaceRef[] = [];
  failCreate = false;

  async create(input: { taskId: string; opts: CreateWorkspaceOpts }): Promise<ProviderWorkspaceRef> {
    if (this.failCreate) throw new Error("clone failed");
    return {
      provider: this.name,
      rootPath: `/fake/${input.opts.name ?? input.taskId}`,
      name: input.opts.name ?? input.taskId,
    };
  }
  async attach(path: string): Promise<ProviderWorkspaceRef> {
    return { provider: this.name, rootPath: path, name: "attached" };
  }
  async tag(_ref: ProviderWorkspaceRef, annotations: Record<string, string>): Promise<void> {
    this.tagged.push(annotations);
  }
  async readTag(): Promise<string | undefined> {
    return undefined;
  }
  async roots(ref: ProviderWorkspaceRef): Promise<string[]> {
    return [ref.rootPath];
  }
  async info(): Promise<WorkspaceInfo> {
    return { provider: this.name };
  }
  async discover(): Promise<ProviderWorkspaceRef[]> {
    return this.discoverable;
  }
}

let store: Store;
let provider: FakeProvider;
let svc: WorkspaceService;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
  provider = new FakeProvider();
  const registry = new ProviderRegistry([provider]);
  svc = new WorkspaceService(store, registry);
});

describe("WorkspaceService", () => {
  it("provisioning → ready with roots/info in meta and tq.task-id tag", async () => {
    const t = store.tasks.create({ title: "x", labels: [{ key: "project", value: "aibm" }] });
    const ws = svc.createForTask(t.id, { provider: "fake", name: "wsx" });
    expect(ws.status).toBe("provisioning");

    await svc.whenSettled(ws.id);
    const ready = store.workspaces.get(ws.id)!;
    expect(ready.status).toBe("ready");
    expect(ready.root_path).toBe("/fake/wsx");
    expect((ready.meta as { roots: string[] }).roots).toEqual(["/fake/wsx"]);
    // label mirror present in the tag annotations
    expect(provider.tagged.some((a) => a["tq.task-id"] === t.id && a["tq.project"] === "aibm")).toBe(
      true,
    );
  });

  it("create failure → error status with message", async () => {
    provider.failCreate = true;
    const t = store.tasks.create({ title: "y" });
    const ws = svc.createForTask(t.id, { provider: "fake" });
    await svc.whenSettled(ws.id);
    const errored = store.workspaces.get(ws.id)!;
    expect(errored.status).toBe("error");
    expect(errored.error).toContain("clone failed");
  });

  it("rejects a second workspace for the same task (1:1)", () => {
    const t = store.tasks.create({ title: "z" });
    svc.createForTask(t.id, { provider: "fake" });
    expect(() => svc.createForTask(t.id, { provider: "fake" })).toThrow(WorkspaceConflictError);
  });

  it("reconcile upserts discovered refs and detaches missing roots", async () => {
    const t = store.tasks.create({ title: "r" });
    provider.discoverable = [
      { provider: "fake", rootPath: "/fake/recon", name: "recon", meta: { "tq.task-id": t.id } },
    ];
    const res = await svc.reconcile();
    expect(res.upserted).toBe(1);
    const ws = store.workspaces.getByPath("/fake/recon")!;
    expect(ws.task_id).toBe(t.id);

    // Now it disappears from disk → detach.
    provider.discoverable = [];
    const res2 = await svc.reconcile();
    expect(res2.detached).toBe(1);
    expect(store.workspaces.get(ws.id)!.status).toBe("detached");
  });

  it("recoverProvisioning flips interrupted rows to error", async () => {
    const t = store.tasks.create({ title: "p" });
    store.workspaces.create({
      task_id: t.id,
      provider: "fake",
      root_path: "/fake/p",
      name: "p",
      status: "provisioning",
    });
    const n = await svc.recoverProvisioning();
    expect(n).toBe(1);
    expect(store.workspaces.getByTask(t.id)!.status).toBe("error");
  });
});
