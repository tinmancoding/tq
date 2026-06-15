import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, defaultConfig, type TqConfig } from "@tq/core";
import { ProviderRegistry } from "../workspace/registry.js";
import { LocalProvider } from "../workspace/local-provider.js";
import { scanForWorkspace, mangleCwd, manglePrefix } from "../sessions/scanner.js";

let root: string;
let sessionsDir: string;
let store: Store;
let registry: ProviderRegistry;
let cfg: TqConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tq-scan-"));
  sessionsDir = join(root, "pi-sessions");
  mkdirSync(sessionsDir, { recursive: true });
  store = Store.open({ path: ":memory:" });
  registry = new ProviderRegistry([new LocalProvider(root)]);
  cfg = { ...defaultConfig(), session: { ...defaultConfig().session, pi_sessions_dir: sessionsDir } };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  store.close();
});

/** Write a synthetic pi session .jsonl with the given header + N messages. */
function writeSession(cwd: string, id: string, messages: { role: string; text: string }[]): string {
  const dir = join(sessionsDir, mangleCwd(cwd), id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
    JSON.stringify({ type: "model_change", modelId: "claude-x" }),
    ...messages.map((m) => JSON.stringify({ type: "message", role: m.role, content: m.text })),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("mangle helpers", () => {
  it("mangles a cwd and shares a prefix with subdirs", () => {
    expect(mangleCwd("/a/b/c")).toBe("--a-b-c--");
    expect(mangleCwd("/a/b/c/sub").startsWith(manglePrefix("/a/b/c"))).toBe(true);
  });
});

describe("scanForWorkspace", () => {
  function workspace(rootPath: string) {
    const t = store.tasks.create({ title: "t" });
    return store.workspaces.create({
      task_id: t.id,
      provider: "local",
      root_path: rootPath,
      name: "ws",
    });
  }

  it("indexes a session whose header cwd is under the root", async () => {
    const wsRoot = join(root, "AIBM3-219");
    mkdirSync(wsRoot, { recursive: true });
    const ws = workspace(wsRoot);
    writeSession(wsRoot, "sess-a", [
      { role: "user", text: "do the thing" },
      { role: "assistant", text: "ok" },
    ]);

    const res = await scanForWorkspace(store, registry, cfg, ws);
    expect(res.discovered).toBe(1);
    const sessions = store.sessions.listForTask(ws.task_id!);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.title).toBe("do the thing");
    expect(sessions[0]!.model).toBe("claude-x");
    expect(sessions[0]!.message_count).toBe(2);
  });

  it("rejects prefix-collision dirs (AIBM3-219 vs AIBM3-2199)", async () => {
    const wsRoot = join(root, "AIBM3-219");
    const otherRoot = join(root, "AIBM3-2199");
    mkdirSync(wsRoot, { recursive: true });
    mkdirSync(otherRoot, { recursive: true });
    const ws = workspace(wsRoot);
    writeSession(wsRoot, "mine", [{ role: "user", text: "mine" }]);
    writeSession(otherRoot, "theirs", [{ role: "user", text: "theirs" }]);

    await scanForWorkspace(store, registry, cfg, ws);
    const sessions = store.sessions.listForTask(ws.task_id!);
    expect(sessions.map((s) => s.id)).toEqual(["mine"]);
  });

  it("tombstones a session whose file disappeared on rescan", async () => {
    const wsRoot = join(root, "ws1");
    mkdirSync(wsRoot, { recursive: true });
    const ws = workspace(wsRoot);
    const file = writeSession(wsRoot, "gone", [{ role: "user", text: "x" }]);
    await scanForWorkspace(store, registry, cfg, ws);
    expect(store.sessions.get("gone")!.file_present).toBe(true);

    rmSync(file);
    const res = await scanForWorkspace(store, registry, cfg, ws);
    expect(res.tombstoned).toBe(1);
    expect(store.sessions.get("gone")!.file_present).toBe(false);
  });

  it("marks recent sessions active and old ones ended", async () => {
    const wsRoot = join(root, "wact");
    mkdirSync(wsRoot, { recursive: true });
    const ws = workspace(wsRoot);
    const fresh = writeSession(wsRoot, "fresh", [{ role: "user", text: "now" }]);
    const old = writeSession(wsRoot, "old", [{ role: "user", text: "then" }]);
    const longAgo = new Date(Date.now() - 3600_000);
    utimesSync(old, longAgo, longAgo);

    await scanForWorkspace(store, registry, cfg, ws);
    expect(store.sessions.get("fresh")!.status).toBe("active");
    expect(store.sessions.get("old")!.status).toBe("ended");
    void fresh;
  });
});
