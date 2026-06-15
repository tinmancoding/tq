import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProvider } from "../workspace/local-provider.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "tq-local-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("LocalProvider", () => {
  it("creates, tags, reads tag, and returns roots", async () => {
    const p = new LocalProvider(base);
    const ref = await p.create({ taskId: "task-123", opts: { name: "my-ws" } });
    expect(ref.provider).toBe("local");
    expect(ref.name).toBe("my-ws");
    expect(existsSync(join(ref.rootPath, ".tq.json"))).toBe(true);

    expect(await p.readTag(ref.rootPath)).toBe("task-123");
    expect(await p.roots(ref)).toEqual([ref.rootPath]);
  });

  it("mirrors labels into the marker via tag()", async () => {
    const p = new LocalProvider(base);
    const ref = await p.create({ taskId: "t1", opts: { name: "w" } });
    await p.tag(ref, { "tq.task-id": "t1", "tq.project": "aibm" });
    const info = await p.info(ref);
    expect((info.labels as Record<string, string>)["tq.project"]).toBe("aibm");
    expect(await p.readTag(ref.rootPath)).toBe("t1");
  });

  it("attach validates a directory and discover finds markers", async () => {
    const p = new LocalProvider(base);
    await p.create({ taskId: "t1", opts: { name: "a" } });
    await p.create({ taskId: "t2", opts: { name: "b" } });

    const attached = await p.attach(join(base, "a"));
    expect(attached.name).toBe("a");
    await expect(p.attach(join(base, "missing"))).rejects.toThrow();

    const found = await p.discover();
    expect(found.map((r) => r.name).sort()).toEqual(["a", "b"]);
    expect(found.find((r) => r.name === "a")!.meta!["tq.task-id"]).toBe("t1");
  });
});
