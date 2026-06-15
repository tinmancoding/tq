// Public surface of @tq/core.
export * from "./domain/types.js";
export { newId, now } from "./domain/ids.js";
export { EventBus, type TqEvent, type TqEventName } from "./events.js";
export {
  EventStore,
  type AppendEventInput,
  type EventRow,
  type EventScopeType,
  type ReadEventsOpts,
} from "./domain/event.js";
export {
  ContextRepo,
  type ContextScope,
  type ContextRef,
  type SetContextResult,
} from "./domain/context.js";
export {
  replay,
  type ReplayState,
  type ReplayTask,
  type ReplayIntake,
  type ReplayRef,
} from "./projection/reduce.js";
export { backfillEvents, type BackfillResult } from "./projection/backfill.js";
export {
  SubscriptionRepo,
  type Subscription,
  type SubscriptionFilters,
  type DeadLetter,
} from "./domain/subscription.js";
export { Store } from "./store.js";
export { openDb, type DB, type OpenDbOptions } from "./db/sqlite.js";

export { TaskRepo, type CreateTaskInput, type UpdateTaskInput } from "./domain/task.js";
export {
  IntakeRepo,
  type CreateIntakeInput,
  type PromoteInput,
} from "./domain/intake.js";
export {
  AttachmentRepo,
  type AttachmentMeta,
  type IntakeAttachment,
} from "./domain/attachment.js";

export {
  search,
  type SearchHit,
  type SearchResult,
  type SearchOpts,
} from "./search/hybrid.js";
export { ftsSearch, indexTask, labelsText, toMatchExpr } from "./search/fts.js";
export {
  isVecAvailable,
  upsertTaskVector,
  removeTaskVector,
  vecSearch,
  type VecHit,
} from "./search/vector.js";
export { type Embedder, taskEmbeddingText } from "./search/embeddings.js";
export { EmbeddingWorker, type EmbeddingWorkerOptions } from "./search/embedding-worker.js";

export {
  loadConfig,
  defaultConfig,
  defaultConfigPath,
  daemonBaseUrl,
  resolveSecret,
  expandHome,
  type TqConfig,
} from "./config.js";

// ── triage ──
// Triage now lives in the @tq/ext-triage extension (event-driven). Core keeps
// only the TriageResult shape (domain/types) that promote reads from context.
