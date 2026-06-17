// @tq/ext-triage — triage as an event-driven SDK extension (Phase G).
export { triageExtension, buildAtlassianClosures, type TriageExtensionOptions } from "./extension.js";
export { PiTriageEngine, overBudget, budgetResult, toToolText, attachmentToToolContent, resolveThinkingLevel, buildToolNames, buildReferencedContextBlock, buildPrefetchTraceSteps, type PiTriageEngineConfig, type BudgetCounter, type AttachmentContentBlock } from "./pi-engine.js";
export { detectRefs, type PrefetchRef, type DetectRefsOptions } from "./prefetch.js";
export { prepareImageForTriage } from "./resize-image.js";
export { decideGate, type GateAction } from "./gate.js";
export { buildTriagePrompt } from "./prompt.js";
export { TriageResultSchema, type TriageResultStatic } from "./schema.js";
export type {
  TriageEngine,
  TriageInput,
  TriageImage,
  TriageInjected,
  TriageSearchHit,
  TriageSearchFn,
  TriageTraceSink,
  TriageResult,
  TriageTraceStep,
  AtlassianClosures,
  AttachmentResult,
} from "./engine.js";
