import { readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { Store, Workspace, TqConfig, AgentSession, SessionStatus } from "@tq/core";
import type { ProviderRegistry } from "../workspace/registry.js";

/**
 * pi mangles a session's cwd into a directory name: strip the leading slash,
 * replace every `/` with `-`, then wrap in `--…--`. A checkout subdir
 * `<root>/<sub>` therefore shares the root's prefix (sans trailing `--`).
 */
export function mangleCwd(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
}

/** The shared prefix (no trailing `--`) used to match a root and its subdirs. */
export function manglePrefix(root: string): string {
  return `--${root.replace(/^\//, "").replace(/\//g, "-")}`;
}

interface SessionHeader {
  id: string;
  cwd: string;
  timestamp?: string;
}

/** Read the first line of a .jsonl and parse the `session` header. */
export function readSessionHeader(file: string): SessionHeader | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString("utf8", 0, n);
    const firstLine = text.split("\n", 1)[0];
    if (!firstLine) return null;
    const obj = JSON.parse(firstLine) as Record<string, unknown>;
    if (obj.type !== "session" || typeof obj.id !== "string" || typeof obj.cwd !== "string") {
      return null;
    }
    return { id: obj.id, cwd: obj.cwd, timestamp: obj.timestamp as string | undefined };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Cheap roll-up of a session file (line scan, no full parse). */
export function rollupSession(file: string): {
  messageCount: number;
  model: string | null;
  title: string | null;
} {
  let messageCount = 0;
  let model: string | null = null;
  let title: string | null = null;
  try {
    const fd = openSync(file, "r");
    try {
      // Read in chunks; files are line-delimited JSON.
      const stat = statSync(file);
      const size = stat.size;
      const buf = Buffer.alloc(Math.min(size, 1024 * 1024));
      const n = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8", 0, n);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = obj.type as string | undefined;
        if (type === "model_change" && typeof obj.modelId === "string") model = obj.modelId;
        if (type === "message" || obj.role) {
          messageCount++;
          if (!title && obj.role === "user") {
            title = extractText(obj.content)?.slice(0, 120) ?? null;
          }
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* unreadable → defaults */
  }
  return { messageCount, model, title };
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) return b.text.trim();
    }
  }
  return null;
}

/** Recursively collect every *.jsonl under a directory. */
function findJsonl(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) findJsonl(full, acc);
    else if (e.isFile() && e.name.endsWith(".jsonl")) acc.push(full);
  }
  return acc;
}

export interface ScanResult {
  discovered: number;
  updated: number;
  tombstoned: number;
}

/**
 * Scan pi's session store for sessions whose header `cwd` lives under any of
 * the workspace's roots, and upsert them into the index. Robust to prefix
 * collisions because matching is by the header cwd, not just dir name.
 */
export async function scanForWorkspace(
  store: Store,
  registry: ProviderRegistry,
  cfg: TqConfig,
  ws: Workspace,
): Promise<ScanResult> {
  const result: ScanResult = { discovered: 0, updated: 0, tombstoned: 0 };
  if (ws.status === "detached" || !ws.root_path) return result;

  let roots: string[];
  try {
    roots = await registry.get(ws.provider).roots({
      provider: ws.provider,
      rootPath: ws.root_path,
      name: ws.name,
    });
  } catch {
    roots = [ws.root_path];
  }

  const sessionsDir = cfg.session.pi_sessions_dir;
  if (!existsSync(sessionsDir)) return result;

  const prefixes = roots.map(manglePrefix);
  let dirEntries: string[] = [];
  try {
    dirEntries = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result;
  }

  const candidateDirs = dirEntries.filter((name) => prefixes.some((p) => name.startsWith(p)));
  const presentFiles: string[] = [];

  for (const dirName of candidateDirs) {
    const files = findJsonl(join(sessionsDir, dirName));
    for (const file of files) {
      const header = readSessionHeader(file);
      if (!header) continue;
      // Confirm cwd really lives under a workspace root (defeats prefix collisions).
      if (!roots.some((r) => header.cwd === r || header.cwd.startsWith(r + "/"))) continue;

      presentFiles.push(file);
      const mtime = statSync(file).mtime;
      const rollup = rollupSession(file);
      const status = sessionStatus(mtime, cfg.session.active_window_sec);
      const { created } = store.sessions.upsert({
        id: header.id,
        task_id: ws.task_id,
        workspace_id: ws.id,
        session_file: file,
        cwd: header.cwd,
        title: rollup.title,
        model: rollup.model,
        message_count: rollup.messageCount,
        started_at: header.timestamp ?? null,
        last_activity_at: mtime.toISOString(),
        status,
      });
      if (created) result.discovered++;
      else result.updated++;
    }
  }

  result.tombstoned = store.sessions.markTombstoned(ws.id, presentFiles);
  store.workspaces.touch(ws.id);
  return result;
}

function sessionStatus(mtime: Date, windowSec: number): SessionStatus {
  const ageSec = (Date.now() - mtime.getTime()) / 1000;
  return ageSec <= windowSec ? "active" : "ended";
}

export type { AgentSession };
