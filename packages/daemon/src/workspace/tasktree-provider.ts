import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import type {
  WorkspaceProvider,
  ProviderWorkspaceRef as WorkspaceRef,
  CreateWorkspaceOpts,
  WorkspaceInfo,
} from "@tq/core";

/** Result of a tasktree shell-out. */
export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Injectable exec fn (mockable in tests). */
export type ExecFn = (args: string[], opts: { cwd?: string }) => ExecResult;

const defaultExec: ExecFn = (args, opts) => {
  const res = spawnSync("tasktree", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: res.status ?? (res.error ? 127 : 1),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
  };
};

export interface TasktreeProviderOptions {
  exec?: ExecFn;
  /** Base directory new tasktrees are created in (default ~/Developer/tasks). */
  baseDir?: string;
  /** Path to the tasktree registry TOML (default ~/.local/state/tasktree/registry.toml). */
  registryPath?: string;
}

/**
 * Thin shell-out over the `tasktree` binary. All argv is fixed/derived — no
 * free-form command injection. Slow ops (clone via `--apply`) are run by the
 * service on a background promise.
 */
export class TasktreeProvider implements WorkspaceProvider {
  readonly name = "tasktree";
  private readonly exec: ExecFn;
  private readonly baseDir: string;
  private readonly registryPath: string;

  constructor(opts: TasktreeProviderOptions = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.baseDir = opts.baseDir ?? join(homedir(), "Developer", "tasks");
    this.registryPath =
      opts.registryPath ?? join(homedir(), ".local", "state", "tasktree", "registry.toml");
  }

  /** True if the tasktree binary is callable. */
  probe(): boolean {
    try {
      return this.run(["--help"], {}, true).status === 0;
    } catch {
      return false;
    }
  }

  async create(input: { taskId: string; opts: CreateWorkspaceOpts }): Promise<WorkspaceRef> {
    const { opts } = input;
    const name = opts.name?.trim() || input.taskId;
    const args = ["init"];

    if (opts.template) {
      const dir = resolve(this.baseDir, name);
      args.push("--from", opts.template, "--name", name, "--dir", dir);
      for (const [k, v] of Object.entries(opts.vars ?? {})) args.push(`${k}=${v}`);
      args.push("--annotate", `tq.task-id=${input.taskId}`);
      for (const [k, v] of Object.entries(opts.annotations ?? {})) {
        if (k === "tq.task-id") continue;
        args.push("--annotate", `${k}=${v}`);
      }
      args.push("--apply");
      this.run(args, {});
      const rootPath = dir;
      const ref: WorkspaceRef = { provider: this.name, rootPath, name };
      return ref;
    }

    // Blank init at <baseDir>/<name>.
    const rootPath = resolve(this.baseDir, name);
    this.run(["init", rootPath], {});
    const ref: WorkspaceRef = { provider: this.name, rootPath, name };
    await this.tag(ref, { "tq.task-id": input.taskId, ...(opts.annotations ?? {}) });
    return ref;
  }

  async attach(path: string): Promise<WorkspaceRef> {
    const rootPath = resolve(path);
    const res = this.run(["-C", rootPath, "root"], {});
    const root = res.stdout.trim();
    if (!root) throw new Error(`not a tasktree: ${rootPath}`);
    return { provider: this.name, rootPath: root, name: this.readName(root) ?? basename(root) };
  }

  async tag(ref: WorkspaceRef, annotations: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(annotations)) {
      this.run(["-C", ref.rootPath, "annotate", "set", k, v], {});
    }
  }

  async readTag(path: string): Promise<string | undefined> {
    const res = this.run(["-C", resolve(path), "annotate", "list"], {}, true);
    if (res.status !== 0) return undefined;
    return parseAnnotations(res.stdout)["tq.task-id"];
  }

  async roots(ref: WorkspaceRef): Promise<string[]> {
    const repos = this.parseRepos(ref.rootPath);
    const roots = new Set<string>([ref.rootPath]);
    for (const r of repos) {
      const abs = isAbsolute(r.path) ? r.path : join(ref.rootPath, r.path);
      roots.add(abs);
    }
    return [...roots];
  }

  async info(ref: WorkspaceRef): Promise<WorkspaceInfo> {
    const repos = this.parseRepos(ref.rootPath);
    const status = this.run(["-C", ref.rootPath, "status"], {}, true);
    return { provider: this.name, repos, status: status.stdout.trim() || undefined };
  }

  async discover(): Promise<WorkspaceRef[]> {
    if (!existsSync(this.registryPath)) return [];
    let parsed: { tasktrees?: { path: string; name?: string }[] };
    try {
      parsed = parseToml(readFileSync(this.registryPath, "utf8")) as never;
    } catch {
      return [];
    }
    const out: WorkspaceRef[] = [];
    for (const entry of parsed.tasktrees ?? []) {
      if (!entry.path || !existsSync(entry.path)) continue;
      const taskId = await this.readTag(entry.path);
      out.push({
        provider: this.name,
        rootPath: entry.path,
        name: entry.name ?? basename(entry.path),
        meta: taskId ? { "tq.task-id": taskId } : {},
      });
    }
    return out;
  }

  // ── helpers ──
  private parseRepos(rootPath: string): { name: string; path: string; ref?: string; branch?: string }[] {
    const res = this.run(["-C", rootPath, "repos"], {}, true);
    if (res.status !== 0) return [];
    return parseReposTable(res.stdout);
  }

  private readName(rootPath: string): string | undefined {
    const yml = join(rootPath, "Tasktree.yml");
    if (!existsSync(yml)) return undefined;
    const m = readFileSync(yml, "utf8").match(/^\s*name:\s*(.+)$/m);
    return m ? m[1]!.trim() : undefined;
  }

  private run(args: string[], opts: { cwd?: string }, allowFailure = false): ExecResult {
    const res = this.exec(args, opts);
    if (res.status !== 0 && !allowFailure) {
      throw new Error(`tasktree ${args.join(" ")} failed (${res.status}): ${res.stderr.trim()}`);
    }
    return res;
  }
}

/** Parse `annotate list` table output → key/value map. */
export function parseAnnotations(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = stdout.split("\n").map((l) => l.trimEnd());
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^KEY\s+VALUE$/.test(line.trim())) continue;
    if (/^No annotations set\.?$/i.test(line.trim())) continue;
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** Parse `repos` table output (NAME PATH REF BRANCH) → rows. */
export function parseReposTable(
  stdout: string,
): { name: string; path: string; ref?: string; branch?: string }[] {
  const rows: { name: string; path: string; ref?: string; branch?: string }[] = [];
  const lines = stdout.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  for (const line of lines) {
    const cols = line.split(/\s{2,}|\t/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    if (cols[0] === "NAME" && cols[1] === "PATH") continue;
    rows.push({ name: cols[0]!, path: cols[1]!, ref: cols[2], branch: cols[3] });
  }
  return rows;
}
