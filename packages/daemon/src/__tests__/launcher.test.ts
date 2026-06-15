import { describe, it, expect, vi } from "vitest";

const spawnMock = vi.fn(() => ({ unref: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { launchSession } = await import("../sessions/launcher.js");

describe("launchSession", () => {
  it("returns a print-command fallback when launcher is empty", () => {
    const res = launchSession("", { cwd: "/ws/a", cmd: "pi", actor: "agent:pi:x" });
    expect(res.launched).toBe(false);
    expect(res.command).toBe("cd '/ws/a' && pi");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("substitutes {cwd}/{cmd} and spawns detached with TQ_ACTOR", () => {
    spawnMock.mockClear();
    const res = launchSession("cmux new -- sh -c '{cmd}' --cwd {cwd}", {
      cwd: "/ws/b",
      cmd: "pi",
      actor: "agent:pi:abc",
    });
    expect(res.launched).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean; env: Record<string, string> },
    ];
    expect(args[1]).toContain("--cwd /ws/b");
    expect(opts.detached).toBe(true);
    expect(opts.env.TQ_ACTOR).toBe("agent:pi:abc");
  });

  it("appends --session for resume", () => {
    const res = launchSession("", {
      cwd: "/ws/c",
      cmd: "pi",
      actor: "a",
      sessionFile: "/ws/c/s.jsonl",
    });
    expect(res.command).toContain("--session '/ws/c/s.jsonl'");
  });
});
