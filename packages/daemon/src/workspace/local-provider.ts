import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import type {
  WorkspaceProvider,
  ProviderWorkspaceRef as WorkspaceRef,
  CreateWorkspaceOpts,
  WorkspaceInfo,
} from "@tq/core";

const MARKER = ".tq.json";

interface Marker {
  "tq.task-id"?: string;
  labels?: Record<string, string>;
}

/**
 * Trivial filesystem-backed provider: a workspace is just a directory carrying
 * a `.tq.json` marker. Used to prove the abstraction before tasktree, and as a
 * degradation target when the `tasktree` binary is absent.
 */
export class LocalProvider implements WorkspaceProvider {
  readonly name = "local";

  /** Base dir new workspaces are created under when `opts.name` is relative. */
  constructor(private readonly baseDir: string) {}

  async create(input: { taskId: string; opts: CreateWorkspaceOpts }): Promise<WorkspaceRef> {
    const name = input.opts.name?.trim() || input.taskId;
    const rootPath = resolve(this.baseDir, name);
    mkdirSync(rootPath, { recursive: true });
    const ref: WorkspaceRef = { provider: this.name, rootPath, name: basename(rootPath) };
    await this.tag(ref, { "tq.task-id": input.taskId, ...(input.opts.annotations ?? {}) });
    return ref;
  }

  async attach(path: string): Promise<WorkspaceRef> {
    const rootPath = resolve(path);
    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
      throw new Error(`not a directory: ${rootPath}`);
    }
    return { provider: this.name, rootPath, name: basename(rootPath) };
  }

  async tag(ref: WorkspaceRef, annotations: Record<string, string>): Promise<void> {
    const marker = this.readMarker(ref.rootPath);
    const taskId = annotations["tq.task-id"];
    const labels = { ...(marker.labels ?? {}) };
    for (const [k, v] of Object.entries(annotations)) {
      if (k === "tq.task-id") continue;
      labels[k] = v;
    }
    const next: Marker = {
      ...marker,
      ...(taskId ? { "tq.task-id": taskId } : {}),
      labels,
    };
    writeFileSync(join(ref.rootPath, MARKER), JSON.stringify(next, null, 2));
  }

  async readTag(path: string): Promise<string | undefined> {
    return this.readMarker(resolve(path))["tq.task-id"];
  }

  async roots(ref: WorkspaceRef): Promise<string[]> {
    return [ref.rootPath];
  }

  async info(ref: WorkspaceRef): Promise<WorkspaceInfo> {
    const marker = this.readMarker(ref.rootPath);
    return { provider: this.name, labels: marker.labels ?? {} };
  }

  async discover(): Promise<WorkspaceRef[]> {
    if (!existsSync(this.baseDir)) return [];
    const out: WorkspaceRef[] = [];
    for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rootPath = join(this.baseDir, entry.name);
      if (!existsSync(join(rootPath, MARKER))) continue;
      const taskId = await this.readTag(rootPath);
      out.push({
        provider: this.name,
        rootPath,
        name: entry.name,
        meta: taskId ? { "tq.task-id": taskId } : {},
      });
    }
    return out;
  }

  private readMarker(rootPath: string): Marker {
    const file = join(rootPath, MARKER);
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Marker;
    } catch {
      return {};
    }
  }
}
