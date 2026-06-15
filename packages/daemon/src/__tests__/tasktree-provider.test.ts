import { describe, it, expect } from "vitest";
import {
  TasktreeProvider,
  parseAnnotations,
  parseReposTable,
  type ExecFn,
  type ExecResult,
} from "../workspace/tasktree-provider.js";

function recordingExec(handler: (args: string[]) => Partial<ExecResult>): {
  exec: ExecFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: ExecFn = (args) => {
    calls.push(args);
    const r = handler(args);
    return { status: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

describe("tasktree table parsers", () => {
  it("parses annotate list output", () => {
    const out = "KEY         VALUE\ntq.task-id  abc123\ntq.project  aibm\n";
    expect(parseAnnotations(out)).toEqual({ "tq.task-id": "abc123", "tq.project": "aibm" });
  });

  it("handles the empty annotations sentinel", () => {
    expect(parseAnnotations("No annotations set.")).toEqual({});
  });

  it("parses repos table with relative paths", () => {
    const out = "NAME   PATH        REF    BRANCH\napi    api         main   main\nweb    web/app     v2     feature\n";
    expect(parseReposTable(out)).toEqual([
      { name: "api", path: "api", ref: "main", branch: "main" },
      { name: "web", path: "web/app", ref: "v2", branch: "feature" },
    ]);
  });
});

describe("TasktreeProvider", () => {
  it("blank-init create runs init then tags tq.task-id", async () => {
    const { exec, calls } = recordingExec(() => ({}));
    const p = new TasktreeProvider({ exec, baseDir: "/base" });
    const ref = await p.create({ taskId: "T1", opts: { name: "ws" } });
    expect(ref.rootPath).toBe("/base/ws");
    expect(calls[0]).toEqual(["init", "/base/ws"]);
    expect(calls).toContainEqual(["-C", "/base/ws", "annotate", "set", "tq.task-id", "T1"]);
  });

  it("template create passes --from/--name/--dir/--annotate/--apply", async () => {
    const { exec, calls } = recordingExec(() => ({}));
    const p = new TasktreeProvider({ exec, baseDir: "/base" });
    await p.create({
      taskId: "T2",
      opts: { name: "feat", template: "aibm-general", vars: { branch: "x" } },
    });
    const init = calls.find((c) => c[0] === "init")!;
    expect(init).toContain("--from");
    expect(init).toContain("aibm-general");
    expect(init).toContain("--apply");
    expect(init).toContain("branch=x");
    expect(init.join(" ")).toContain("--annotate tq.task-id=T2");
  });

  it("readTag parses tq.task-id via annotate list", async () => {
    const { exec } = recordingExec((args) =>
      args.includes("list") ? { stdout: "KEY  VALUE\ntq.task-id  HELLO\n" } : {},
    );
    const p = new TasktreeProvider({ exec });
    expect(await p.readTag("/some/path")).toBe("HELLO");
  });

  it("roots includes the root plus each checkout subdir (absolute)", async () => {
    const { exec } = recordingExec((args) =>
      args.includes("repos")
        ? { stdout: "NAME  PATH   REF   BRANCH\napi   api    main  main\nweb   web    main  main\n" }
        : {},
    );
    const p = new TasktreeProvider({ exec });
    const roots = await p.roots({ provider: "tasktree", rootPath: "/ws/root", name: "root" });
    expect(roots).toEqual(["/ws/root", "/ws/root/api", "/ws/root/web"]);
  });

  it("discover parses the registry TOML and attaches tq.task-id", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "tt-reg-"));
    const wsPath = join(dir, "ws1");
    mkdirSync(wsPath);
    const registryPath = join(dir, "registry.toml");
    writeFileSync(
      registryPath,
      `version = 1\n[[tasktrees]]\npath = '${wsPath}'\nname = 'ws1'\n`,
    );
    const { exec } = recordingExec((args) =>
      args.includes("list") ? { stdout: "KEY  VALUE\ntq.task-id  TX\n" } : {},
    );
    const p = new TasktreeProvider({ exec, registryPath });
    const refs = await p.discover();
    expect(refs).toHaveLength(1);
    expect(refs[0]!.rootPath).toBe(wsPath);
    expect(refs[0]!.meta!["tq.task-id"]).toBe("TX");
  });
});
