// @tq/ext-triage — triage as an event-driven SDK extension (Phase G).
export { triageExtension, type TriageExtensionOptions } from "./extension.js";
export { PiTriageEngine, type PiTriageEngineConfig } from "./pi-engine.js";
export { prepareImageForTriage } from "./resize-image.js";
export { decideGate, type GateAction } from "./gate.js";
export { buildTriagePrompt } from "./prompt.js";
export { TriageResultSchema, type TriageResultStatic } from "./schema.js";
export type {
  TriageEngine,
  TriageInput,
  TriageImage,
  TriageSearchHit,
  TriageSearchFn,
  TriageTraceSink,
  TriageResult,
  TriageTraceStep,
} from "./engine.js";
