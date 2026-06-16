/** Produces an embedding vector for a piece of text. */
export interface Embedder {
  /** Target dimensionality of produced vectors. */
  readonly dims: number;
  embed(text: string): Promise<number[]>;
}

/** Flatten a task into the text we embed (title carries most signal). */
export function taskEmbeddingText(title: string, body: string | null): string {
  return body ? `${title}\n\n${body}` : title;
}

/**
 * Zero-dependency local embedder: hashes tokens into a fixed-dim bag and L2-
 * normalizes. Deterministic and offline — the default so the system has NO hard
 * AWS dependency (Q9). It is lexical, not deep-semantic; swap in Titan (or a
 * Transformers.js provider) via config for real semantic recall.
 */
export class HashEmbedder implements Embedder {
  constructor(readonly dims = 256) {}

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dims).fill(0);
    for (const tok of tokenize(text)) {
      const i = fnv1a(tok) % this.dims;
      v[i] = (v[i] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 0);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
