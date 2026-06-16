import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { prepareImageForTriage } from "../resize-image.js";

const dir = mkdtempSync(join(tmpdir(), "tq-resize-"));

async function writePng(name: string, w: number, h: number): Promise<string> {
  const buf = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

async function dims(b64: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(Buffer.from(b64, "base64")).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe("prepareImageForTriage", () => {
  it("passes small images through untouched", async () => {
    const p = await writePng("small.png", 800, 600);
    const out = await prepareImageForTriage(p, "image/png");
    expect(out).not.toBeNull();
    expect(out!.mediaType).toBe("image/png");
    expect(await dims(out!.dataBase64)).toEqual({ width: 800, height: 600 });
  });

  it("downscales the long edge of oversized images to 1568px (Bedrock 8000px limit)", async () => {
    // Tall screenshot like the one that broke Bedrock validation.
    const p = await writePng("tall.png", 1600, 9000);
    const out = await prepareImageForTriage(p, "image/png");
    expect(out).not.toBeNull();
    const { width, height } = await dims(out!.dataBase64);
    expect(height).toBe(1568);
    expect(width).toBeLessThanOrEqual(1568);
    // aspect ratio preserved
    expect(width).toBe(Math.round((1600 / 9000) * 1568));
  });

  it("downscales wide images by width", async () => {
    const p = await writePng("wide.png", 10000, 1200);
    const out = await prepareImageForTriage(p, "image/png");
    const { width } = await dims(out!.dataBase64);
    expect(width).toBe(1568);
  });

  it("returns null for a missing file", async () => {
    expect(await prepareImageForTriage(join(dir, "nope.png"), "image/png")).toBeNull();
  });
});
