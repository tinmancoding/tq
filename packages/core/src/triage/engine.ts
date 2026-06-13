import type { Intake, Label, TriageResult } from "../domain/types.js";

export interface TriageImage {
  mediaType: string; // image/png, image/jpeg, …
  dataBase64: string;
}

export interface TriageInput {
  intake: Intake;
  images: TriageImage[];
}

/** Candidate returned to the LLM by the search_tasks tool. */
export interface TriageSearchHit {
  id: string;
  title: string;
  snippet: string;
  labels: Label[];
  status: string;
  score: number;
}

export type TriageSearchFn = (query: string, limit: number) => Promise<TriageSearchHit[]>;

/**
 * Abstraction over "run an LLM triage pass". The real implementation (in the
 * daemon) drives a pi SDK session against Bedrock with search_tasks/emit_triage
 * tools; tests inject a deterministic mock.
 */
export interface TriageEngine {
  triage(input: TriageInput, searchTasks: TriageSearchFn): Promise<TriageResult>;
}
