/**
 * attachment.ts — preprocess attachment bytes into model-ready content.
 *
 * Implements the Q8 type tiers:
 *   image/*           → resize to 1568px long edge → { images: [{mime, dataBase64}] }
 *   text/* / .md / .csv / .json / .log
 *                     → UTF-8 text, truncated → { text }
 *   application/pdf   → text extraction (pdf-parse); empty → note; → { text }
 *   everything else   → { text: "unsupported type in v1: <mime>" }
 *
 * PDF library choice: `pdf-parse` (not `pdfjs-dist`).
 * Rationale: pdf-parse is a pure-JS wrapper around pdfjs-dist's core text
 * extraction API. It has a much smaller install footprint, no WASM/canvas
 * dependencies, and its API (`pdf(buffer) → { text }`) is trivially testable.
 * pdfjs-dist bundles the full viewer + WASM worker, which is ~10× heavier and
 * adds native build-time complexity we don't need for text-only extraction.
 */

import sharp from "sharp";
import { truncate } from "./shape.js";

const MAX_EDGE = 1568;
const TEXT_MAX_CHARS = 20_000;

export interface AttachmentImage {
  mime: string;
  dataBase64: string;
}

export interface PreprocessedAttachment {
  text?: string;
  images?: AttachmentImage[];
}

/** MIME types we treat as plain text. */
const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/x-ndjson",
]);

/** File-extension suffixes we also treat as plain text regardless of mime. */
const TEXT_EXTS = new Set([".md", ".csv", ".json", ".log", ".txt", ".ndjson"]);

function isTextMime(mime: string): boolean {
  if (TEXT_MIMES.has(mime)) return true;
  // Catch text/* variants not in the set
  if (mime.startsWith("text/")) return true;
  return false;
}

function isTextFilename(filename?: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return [...TEXT_EXTS].some((ext) => lower.endsWith(ext));
}

/**
 * Preprocess attachment bytes into a model-ready shape.
 *
 * @param bytes    Raw attachment bytes.
 * @param mime     MIME type (e.g. "image/png").
 * @param filename Optional filename for extension-based text detection.
 */
export async function preprocessAttachment(
  bytes: Uint8Array,
  mime: string,
  filename?: string,
): Promise<PreprocessedAttachment> {
  const buf = Buffer.from(bytes);

  // --- Image tier ---
  if (mime.startsWith("image/")) {
    return resizeImage(buf, mime);
  }

  // --- Text tier ---
  if (isTextMime(mime) || isTextFilename(filename)) {
    const text = buf.toString("utf-8");
    return { text: truncate(text, TEXT_MAX_CHARS) };
  }

  // --- PDF tier ---
  if (mime === "application/pdf") {
    return extractPdfText(buf);
  }

  // --- Unsupported ---
  return {
    text: `[unsupported attachment type in v1: ${mime}${filename ? ` (${filename})` : ""}]`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resizeImage(buf: Buffer, mime: string): Promise<PreprocessedAttachment> {
  try {
    const img = sharp(buf, { failOn: "none" });
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;

    let outBuf: Buffer;
    let outMime: string;

    if (w <= MAX_EDGE && h <= MAX_EDGE) {
      // Small enough — pass through original bytes.
      outBuf = buf;
      outMime = mime;
    } else {
      // Downscale long edge to MAX_EDGE, preserving aspect ratio.
      outBuf = await img
        .rotate() // honour EXIF orientation
        .resize({
          width: w >= h ? MAX_EDGE : undefined,
          height: h > w ? MAX_EDGE : undefined,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
      outMime = "image/png";
    }

    return {
      images: [{ mime: outMime, dataBase64: outBuf.toString("base64") }],
    };
  } catch {
    // Decode/resize failed — return original bytes as-is.
    return {
      images: [{ mime, dataBase64: buf.toString("base64") }],
    };
  }
}

async function extractPdfText(buf: Buffer): Promise<PreprocessedAttachment> {
  try {
    // pdf-parse has no named ESM export; import() works via CJS interop and
    // allows vi.mock() to intercept it cleanly in tests.
    const mod = await import("pdf-parse");
    // The module may be the default export or the module itself depending on interop.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const pdfParse = ((mod as { default?: unknown }).default ?? mod) as (
      buf: Buffer,
      options?: Record<string, unknown>,
    ) => Promise<{ text: string }>;
    const data = await pdfParse(buf);
    const extracted = data.text.trim();
    if (!extracted) {
      return { text: "[PDF attachment: no extractable text found]" };
    }
    return { text: truncate(extracted, TEXT_MAX_CHARS) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `[PDF text extraction failed: ${msg}]` };
  }
}
