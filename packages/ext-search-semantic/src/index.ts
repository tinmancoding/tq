// @tq/ext-search-semantic — vector/hybrid search as a projection extension (Phase H).
export { searchSemanticExtension, type SearchSemanticOptions } from "./extension.js";
export { SemanticStore, type VecHit } from "./store.js";
export { HashEmbedder, taskEmbeddingText, type Embedder } from "./embedder.js";
export { TitanEmbedder, type TitanEmbedderConfig } from "./titan.js";
