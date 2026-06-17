/**
 * attachment.test.ts — unit tests for attachment preprocessing.
 *
 * Tests cover the Q8 tiers:
 *   - image/* → resize
 *   - text/* / known text extensions → text passthrough
 *   - application/pdf → text extraction
 *   - unsupported → note
 */

import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { preprocessAttachment } from "../attachment.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

async function pngDims(dataBase64: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(Buffer.from(dataBase64, "base64")).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

// ---------------------------------------------------------------------------
// Image tier
// ---------------------------------------------------------------------------

describe("preprocessAttachment – image tier", () => {
  it("returns images array with small image passed through (≤1568px)", async () => {
    const bytes = await makePng(800, 600);
    const result = await preprocessAttachment(bytes, "image/png");

    expect(result.images).toHaveLength(1);
    expect(result.text).toBeUndefined();
    const dims = await pngDims(result.images![0]!.dataBase64);
    expect(dims).toEqual({ width: 800, height: 600 });
  });

  it("resizes a tall image so the long edge is 1568px", async () => {
    const bytes = await makePng(800, 3200);
    const result = await preprocessAttachment(bytes, "image/png");

    expect(result.images).toHaveLength(1);
    const dims = await pngDims(result.images![0]!.dataBase64);
    expect(dims.height).toBe(1568);
    expect(dims.width).toBeLessThan(1568);
  });

  it("resizes a wide image so the long edge is 1568px", async () => {
    const bytes = await makePng(4000, 1000);
    const result = await preprocessAttachment(bytes, "image/png");

    expect(result.images).toHaveLength(1);
    const dims = await pngDims(result.images![0]!.dataBase64);
    expect(dims.width).toBe(1568);
  });

  it("sets mime to image/png after resize re-encoding", async () => {
    const bytes = await makePng(4000, 1000);
    const result = await preprocessAttachment(bytes, "image/jpeg");

    // Resized images are re-encoded as PNG
    expect(result.images![0]!.mime).toBe("image/png");
  });

  it("preserves the original mime for small images", async () => {
    const bytes = await makePng(100, 100);
    const result = await preprocessAttachment(bytes, "image/gif");

    expect(result.images![0]!.mime).toBe("image/gif");
  });
});

// ---------------------------------------------------------------------------
// Text tier
// ---------------------------------------------------------------------------

describe("preprocessAttachment – text tier", () => {
  it("returns text for text/plain mime", async () => {
    const content = "Hello, world!\nThis is plain text.";
    const bytes = new TextEncoder().encode(content);
    const result = await preprocessAttachment(bytes, "text/plain");

    expect(result.text).toBe(content);
    expect(result.images).toBeUndefined();
  });

  it("returns text for text/markdown mime", async () => {
    const content = "# Heading\n\nBody text.";
    const bytes = new TextEncoder().encode(content);
    const result = await preprocessAttachment(bytes, "text/markdown");

    expect(result.text).toBe(content);
  });

  it("returns text for application/json mime", async () => {
    const content = '{"key":"value"}';
    const bytes = new TextEncoder().encode(content);
    const result = await preprocessAttachment(bytes, "application/json");

    expect(result.text).toBe(content);
  });

  it("returns text for .json extension regardless of mime", async () => {
    const content = '{"key":"value"}';
    const bytes = new TextEncoder().encode(content);
    // application/octet-stream but .json extension
    const result = await preprocessAttachment(bytes, "application/octet-stream", "data.json");

    expect(result.text).toBe(content);
  });

  it("returns text for .md extension", async () => {
    const content = "# Notes\n\nSome notes.";
    const bytes = new TextEncoder().encode(content);
    const result = await preprocessAttachment(bytes, "application/octet-stream", "notes.md");

    expect(result.text).toBe(content);
  });

  it("returns text for .log extension", async () => {
    const content = "2024-01-01 INFO: started";
    const bytes = new TextEncoder().encode(content);
    const result = await preprocessAttachment(bytes, "application/octet-stream", "app.log");

    expect(result.text).toBe(content);
  });

  it("truncates very long text", async () => {
    const content = "x".repeat(25_000);
    const bytes = new TextEncoder().encode(content);
    const result = await preprocessAttachment(bytes, "text/plain");

    expect(result.text).toBeDefined();
    expect(result.text!.startsWith("x".repeat(20_000))).toBe(true);
    expect(result.text!).toContain("truncated");
    expect(result.text!).toContain("5000 chars omitted");
  });
});

// ---------------------------------------------------------------------------
// PDF tier — pdf-parse is mocked with vi.mock so we can exercise all three
// distinct outcome paths (Q8) without needing a real PDF file.
// ---------------------------------------------------------------------------

vi.mock("pdf-parse", () => {
  // Default factory: returns text. Individual tests override with mockResolvedValueOnce.
  const mock = vi.fn().mockResolvedValue({ text: "Extracted PDF text content" });
  return { default: mock };
});

describe("preprocessAttachment – PDF tier", () => {
  it("(a) extracts and returns text when pdf-parse yields content", async () => {
    // Default mock returns { text: "Extracted PDF text content" }
    const bytes = new TextEncoder().encode("%PDF-1.4 placeholder");
    const result = await preprocessAttachment(bytes, "application/pdf");

    expect(result.text).toBe("Extracted PDF text content");
    expect(result.images).toBeUndefined();
  });

  it("(b) returns the exact empty-text note when pdf-parse yields empty string", async () => {
    const { default: pdfParse } = await import("pdf-parse");
    vi.mocked(pdfParse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: "" });

    const bytes = new TextEncoder().encode("%PDF-1.4 placeholder");
    const result = await preprocessAttachment(bytes, "application/pdf");

    expect(result.text).toBe("[PDF attachment: no extractable text found]");
    expect(result.images).toBeUndefined();
  });

  it("(c) returns the exact extraction-failed note when pdf-parse throws", async () => {
    const { default: pdfParse } = await import("pdf-parse");
    vi.mocked(pdfParse).mockRejectedValueOnce(new Error("invalid xref table"));

    const bytes = new TextEncoder().encode("%PDF-1.4 placeholder");
    const result = await preprocessAttachment(bytes, "application/pdf");

    expect(result.text).toBe("[PDF text extraction failed: invalid xref table]");
    expect(result.images).toBeUndefined();
  });

  it("truncates very long PDF text", async () => {
    const { default: pdfParse } = await import("pdf-parse");
    vi.mocked(pdfParse as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "A".repeat(25_000),
    });

    const bytes = new TextEncoder().encode("%PDF-1.4 placeholder");
    const result = await preprocessAttachment(bytes, "application/pdf");

    expect(result.text).toBeDefined();
    expect(result.text).toContain("truncated");
    expect(result.text!.startsWith("A".repeat(20_000))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unsupported tier
// ---------------------------------------------------------------------------

describe("preprocessAttachment – unsupported tier", () => {
  it("returns a note for application/zip", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // ZIP magic bytes
    const result = await preprocessAttachment(bytes, "application/zip");

    expect(result.text).toBeDefined();
    expect(result.text).toContain("unsupported");
    expect(result.text).toContain("application/zip");
    expect(result.images).toBeUndefined();
  });

  it("includes the filename in the unsupported note if provided", async () => {
    const bytes = new Uint8Array([0]);
    const result = await preprocessAttachment(
      bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "report.xlsx",
    );

    expect(result.text).toContain("unsupported");
    expect(result.text).toContain("report.xlsx");
  });

  it("returns unsupported note for application/octet-stream without known extension", async () => {
    const bytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const result = await preprocessAttachment(bytes, "application/octet-stream");

    expect(result.text).toContain("unsupported");
  });
});
