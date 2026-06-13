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
