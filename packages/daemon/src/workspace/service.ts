import type { Store, Workspace, Task } from "@tq/core";
import { WorkspaceConflictError } from "@tq/core";
import type { CreateWorkspaceOpts, ProviderWorkspaceRef } from "@tq/core";
import { existsSync } from "node:fs";
import type { ProviderRegistry } from "./registry.js";

export interface CreateForTaskOpts extends CreateWorkspaceOpts {
  provider?: string;
}

/**
 * Daemon-side orchestration of the workspace lifecycle. core holds the repo +
 * provider interface; this binds them to the binary-backed providers and runs
 * the slow (clone) path asynchronously with status transitions + SSE.
 */
export class WorkspaceService {
  /** In-flight materialize promises by workspace id (test/await hook). */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly registry: ProviderRegistry,
  ) {}

  /**
   * Insert a `provisioning` row immediately, then materialize on a background
   * promise. Returns the provisioning workspace (HTTP 202).
   */
  createForTask(taskId: string, opts: CreateForTaskOpts): Workspace {
    const providerName = opts.provider ?? this.registry.defaultName();
    const provider = this.registry.get(providerName);
    const name = opts.name?.trim() || taskId;

    // The path isn't known until create resolves; seed with a best-effort
    // placeholder that the materialize step overwrites via setMeta + path.
    const ws = this.store.workspaces.create({
      task_id: taskId,
      provider: providerName,
      root_path: "",
      name,
      status: "provisioning",
    });

    const p = this.materialize(ws.id, taskId, provider, opts);
    this.inflight.set(ws.id, p);
    void p.finally(() => this.inflight.delete(ws.id));
    return ws;
  }

  /** Await an in-flight materialize (resolves immediately if already settled). */
  async whenSettled(workspaceId: string): Promise<void> {
    await this.inflight.get(workspaceId);
  }

  private async materialize(
    workspaceId: string,
    taskId: string,
    provider: ReturnType<ProviderRegistry["get"]>,
    opts: CreateForTaskOpts,
  ): Promise<void> {
    try {
      const annotations = { "tq.task-id": taskId, ...this.labelAnnotations(taskId) };
      const ref = await provider.create({ taskId, opts: { ...opts, annotations } });
      await provider.tag(ref, annotations);
      const roots = await provider.roots(ref);
      const info = await provider.info(ref);
      this.patchRow(workspaceId, ref);
      this.store.workspaces.setMeta(workspaceId, { ...ref.meta, roots, info });
      this.store.workspaces.setStatus(workspaceId, "ready");
    } catch (err) {
      this.store.workspaces.setStatus(
        workspaceId,
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Adopt an existing on-disk workspace and stamp the backref. */
  async attachExisting(taskId: string, path: string, providerName?: string): Promise<Workspace> {
    const name = providerName ?? this.registry.defaultName();
    const provider = this.registry.get(name);
    const ref = await provider.attach(path);
    const annotations = { "tq.task-id": taskId, ...this.labelAnnotations(taskId) };
    await provider.tag(ref, annotations);
    const roots = await provider.roots(ref);
    const info = await provider.info(ref);
    const ws = this.store.workspaces.create({
      task_id: taskId,
      provider: name,
      root_path: ref.rootPath,
      name: ref.name,
      status: "ready",
      meta: { ...ref.meta, roots, info },
    });
    return ws;
  }

  /** One-way, best-effort label mirror → `tq.<key>` annotations. */
  async mirrorLabels(taskId: string): Promise<void> {
    const ws = this.store.workspaces.getByTask(taskId);
    if (!ws || ws.status !== "ready" || !ws.root_path) return;
    let provider;
    try {
      provider = this.registry.get(ws.provider);
    } catch {
      return;
    }
    const ref: ProviderWorkspaceRef = {
      provider: ws.provider,
      rootPath: ws.root_path,
      name: ws.name,
    };
    const annotations = { "tq.task-id": taskId, ...this.labelAnnotations(taskId) };
    try {
      await provider.tag(ref, annotations);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Rebuild the workspace cache from disk truth across all providers. Upserts
   * discovered refs (re-linking via `tq.task-id`) and marks rows whose root
   * vanished as detached.
   */
  async reconcile(): Promise<{ upserted: number; detached: number }> {
    const seen = new Set<string>();
    let upserted = 0;
    for (const provider of this.registry.all()) {
      let refs: ProviderWorkspaceRef[] = [];
      try {
        refs = await provider.discover();
      } catch {
        continue;
      }
      for (const ref of refs) {
        const taskId =
          (ref.meta?.["tq.task-id"] as string | undefined) ??
          (await safe(() => provider.readTag(ref.rootPath)));
        this.store.workspaces.upsertFromRef({
          provider: ref.provider,
          rootPath: ref.rootPath,
          name: ref.name,
          taskId: taskId && this.store.tasks.get(taskId) ? taskId : undefined,
          meta: ref.meta,
        });
        seen.add(ref.rootPath);
        upserted++;
      }
    }
    // Detach live rows whose disk root is gone.
    let detached = 0;
    for (const ws of this.store.workspaces.list()) {
      if (ws.status === "detached") continue;
      if (ws.root_path && !seen.has(ws.root_path) && !existsSync(ws.root_path)) {
        this.store.workspaces.detach(ws.id);
        detached++;
      }
    }
    return { upserted, detached };
  }

  /** Detach a task's workspace (row → detached, never touches disk). */
  detach(taskId: string): Workspace | null {
    const ws = this.store.workspaces.getByTask(taskId);
    if (!ws) return null;
    return this.store.workspaces.detach(ws.id);
  }

  /**
   * Crash recovery: any `provisioning` row from a previous run is suspect.
   * Re-probe disk: flip to `ready` if the backref resolves, else `error`.
   */
  async recoverProvisioning(): Promise<number> {
    let n = 0;
    for (const ws of this.store.workspaces.list({ status: "provisioning" })) {
      let provider;
      try {
        provider = this.registry.get(ws.provider);
      } catch {
        this.store.workspaces.setStatus(ws.id, "error", "provider unavailable after restart");
        n++;
        continue;
      }
      const taskId = ws.root_path ? await safe(() => provider!.readTag(ws.root_path)) : undefined;
      if (ws.root_path && taskId) {
        this.store.workspaces.setStatus(ws.id, "ready");
      } else {
        this.store.workspaces.setStatus(ws.id, "error", "provisioning interrupted by restart");
      }
      n++;
    }
    return n;
  }

  private labelAnnotations(taskId: string): Record<string, string> {
    const task: Task | null = this.store.tasks.get(taskId);
    if (!task) return {};
    const byKey = new Map<string, string[]>();
    for (const l of task.labels) {
      const arr = byKey.get(l.key) ?? [];
      arr.push(l.value);
      byKey.set(l.key, arr);
    }
    const out: Record<string, string> = {};
    for (const [key, values] of byKey) out[`tq.${key}`] = values.join(",");
    return out;
  }

  private patchRow(workspaceId: string, ref: ProviderWorkspaceRef): void {
    // root_path/name are only known after create resolves.
    this.store.db
      .prepare(`UPDATE workspace SET root_path = ?, name = ? WHERE id = ?`)
      .run(ref.rootPath, ref.name, workspaceId);
  }
}

export { WorkspaceConflictError };

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
