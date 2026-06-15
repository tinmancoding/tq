/**
 * Host-agnostic workspace provider seam. core declares the interface; the
 * daemon supplies binary-backed implementations (`TasktreeProvider`,
 * `LocalProvider`). Mirrors the `TriageEngine` (core) ⟷ `PiTriageEngine`
 * (daemon) split so core stays free of `child_process`/host concerns.
 */

/** A concrete workspace location on disk. */
export interface WorkspaceRef {
  provider: string;
  rootPath: string;
  name: string;
  meta?: Record<string, unknown>;
}

export interface CreateWorkspaceOpts {
  name?: string;
  template?: string;
  vars?: Record<string, string>;
  /** Durable annotations to stamp at init time (includes `tq.task-id`). */
  annotations?: Record<string, string>;
}

export interface WorkspaceInfo {
  repos?: unknown[];
  status?: unknown;
  [k: string]: unknown;
}

export interface WorkspaceProvider {
  readonly name: string;
  /** Provision on disk. May be slow (clone); callers run it async. */
  create(input: { taskId: string; opts: CreateWorkspaceOpts }): Promise<WorkspaceRef>;
  /** Adopt an existing directory. */
  attach(path: string): Promise<WorkspaceRef>;
  /** Write the durable backref + label mirror. */
  tag(ref: WorkspaceRef, annotations: Record<string, string>): Promise<void>;
  /** Read the durable `tq.task-id` from a path (for discovery/reconcile). */
  readTag(path: string): Promise<string | undefined>;
  /** cwd roots to launch in and to scan for sessions (root + checkout subdirs). */
  roots(ref: WorkspaceRef): Promise<string[]>;
  /** Provider-specific display bag (open/optional). */
  info(ref: WorkspaceRef): Promise<WorkspaceInfo>;
  /** Enumerate candidate workspaces on the host (for reconcile). */
  discover(): Promise<WorkspaceRef[]>;
}
