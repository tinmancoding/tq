import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { TriageImage } from "@tq/core";

/**
 * Bedrock rejects images whose width or height exceeds 8000px, and Anthropic
 * downscales anything past ~1568px on the long edge before the model sees it
 * anyway. So we cap the long edge at 1568px: this avoids the hard error and
 * trims tokens/latency without losing detail the model would have kept.
 */
const MAX_EDGE = 1568;

/**
 * Load an image attachment and prepare it for the triage model: resize if it is
 * larger than the model can accept, otherwise pass the original bytes through.
 * Returns null if the file can't be read/decoded.
 */
export async function prepareImageForTriage(
  filePath: string,
  mime: string,
): Promise<TriageImage | null> {
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    return null;
  }

  try {
    const img = sharp(buf, { failOn: "none" });
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;

    if (w <= MAX_EDGE && h <= MAX_EDGE) {
      // Small enough — send the original bytes untouched.
      return { mediaType: mime, dataBase64: buf.toString("base64") };
    }

    // Downscale the long edge to MAX_EDGE, preserving aspect ratio. Re-encode
    // to PNG (lossless) so screenshot text stays crisp.
    const resized = await img
      .rotate() // honour EXIF orientation before resizing
      .resize({ width: w >= h ? MAX_EDGE : undefined, height: h > w ? MAX_EDGE : undefined, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return { mediaType: "image/png", dataBase64: resized.toString("base64") };
  } catch {
    // Decode/resize failed — fall back to the raw bytes (may still be valid).
    return { mediaType: mime, dataBase64: buf.toString("base64") };
  }
}
