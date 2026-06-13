// Public surface of @tq/core.
export * from "./domain/types.js";
export { newId, now } from "./domain/ids.js";
export { EventBus, type TqEvent, type TqEventName } from "./events.js";
export { Store } from "./store.js";
export { openDb, type DB, type OpenDbOptions } from "./db/sqlite.js";

export { TaskRepo, type CreateTaskInput, type UpdateTaskInput } from "./domain/task.js";
export {
  IntakeRepo,
  type CreateIntakeInput,
  type PromoteInput,
} from "./domain/intake.js";
export { JobRepo, type TriageJob } from "./domain/job.js";

export {
  search,
  type SearchHit,
  type SearchResult,
  type SearchOpts,
} from "./search/hybrid.js";
export { ftsSearch, indexTask, labelsText, toMatchExpr } from "./search/fts.js";

export {
  loadConfig,
  defaultConfig,
  defaultConfigPath,
  daemonBaseUrl,
  resolveSecret,
  expandHome,
  type TqConfig,
} from "./config.js";
