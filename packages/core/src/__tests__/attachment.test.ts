import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tq-att-"));
  store = Store.open({ path: ":memory:", attachmentsDir: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("AttachmentRepo", () => {
  it("stores content-addressed blobs and dedupes identical bytes", () => {
    const a = store.attachments.store(Buffer.from("hello"), { mime: "text/plain" });
    const b = store.attachments.store(Buffer.from("hello"), { mime: "text/plain" });
    expect(a).toBe(b);
    expect(existsSync(store.attachments.filePath(a))).toBe(true);
    expect(store.attachments.meta(a)!.bytes).toBe(5);
  });

  it("links attachments to an intake and lists them in order", () => {
    const { intake } = store.intake.create({ body: "with images" });
    const s1 = store.attachments.store(Buffer.from("img1"), { mime: "image/png" });
    const s2 = store.attachments.store(Buffer.from("img2"), { mime: "image/jpeg" });
    store.attachments.link(intake.id, s1, "a.png", 0);
    store.attachments.link(intake.id, s2, "b.jpg", 1);

    const list = store.attachments.forIntake(intake.id);
    expect(list.map((x) => x.filename)).toEqual(["a.png", "b.jpg"]);
    expect(list[0]!.mime).toBe("image/png");
  });

  it("reads blob bytes back as base64", () => {
    const sha = store.attachments.store(Buffer.from("abc"), { mime: "text/plain" });
    expect(store.attachments.readBase64(sha)).toBe(Buffer.from("abc").toString("base64"));
  });
});
