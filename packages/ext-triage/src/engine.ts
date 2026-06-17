import type { Intake, Label, TriageResult, TriageTraceStep } from "@tq/contract";

export type { TriageResult, TriageTraceStep };

export interface TriageImage {
  mediaType: string; // image/png, image/jpeg, …
  dataBase64: string;
}

/** Callback used by an engine to surface the session transcript to the worker. */
export type TriageTraceSink = (trace: TriageTraceStep[]) => void;

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

/** Result shape returned by the fetch_attachment closure. */
export interface AttachmentResult {
  text?: string;
  images?: Array<{ mime: string; dataBase64: string }>;
}

/**
 * The 5 Atlassian closures injected into the engine (design §3.1).
 * Each returns the normalized result object or a plain error-text string
 * (never throws into the agent loop).
 */
export interface AtlassianClosures {
  jira_get(ref: string, include?: string[]): Promise<unknown>;
  jira_search(jql: string, limit: number): Promise<unknown>;
  confluence_get(ref: string, include?: string[]): Promise<unknown>;
  confluence_search(cql: string, limit: number): Promise<unknown>;
  fetch_attachment(ref: string, mimeHint: string): Promise<AttachmentResult | string>;
}

/**
 * Everything the engine needs beyond the raw intake.
 * Passed as a single object so future additions don't change the positional
 * arity of `triage()`.
 */
export interface TriageInjected {
  searchTasks: TriageSearchFn;
  atlassianEnabled: boolean;
  atlassian?: AtlassianClosures;
}

/**
 * Abstraction over "run an LLM triage pass". The real implementation (in the
 * daemon) drives a pi SDK session against Bedrock with search_tasks/emit_triage
 * tools; tests inject a deterministic mock.
 */
export interface TriageEngine {
  triage(
    input: TriageInput,
    injected: TriageInjected,
    onTrace?: TriageTraceSink,
  ): Promise<TriageResult>;
}
