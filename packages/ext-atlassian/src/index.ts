/**
 * @tq/ext-atlassian — public exports.
 *
 * Phase A: REST client, shaping, normalization, attachment preprocessing, refs.
 * Phase B: Extension definition + gateway endpoints.
 */

export { AtlassianClient } from "./client.js";
export type {
  AtlassianClientConfig,
  AtlassianError,
  AttachmentBytes,
  AtlassianResult,
  RawJiraIssue,
  RawConfluencePage,
  RawJiraSearchResult,
  RawConfluenceSearchResult,
  RawConfluencePageLabels,
  RawConfluencePageComments,
  RawConfluencePageAttachments,
} from "./client.js";
export { isAtlassianError } from "./client.js";

export { htmlToMarkdown, truncate } from "./shape.js";

export {
  normalizeIssue,
  normalizePage,
  normalizeJiraSearchResults,
  normalizeConfluenceSearchResults,
} from "./normalize.js";
export type {
  NormalizedIssue,
  NormalizedPage,
  JiraSearchHit,
  ConfluenceSearchHit,
  IncludeFlag,
} from "./normalize.js";

export { preprocessAttachment } from "./attachment.js";
export type { PreprocessedAttachment, AttachmentImage } from "./attachment.js";

export { parseRef, extractRefs } from "./refs.js";
export type { ParsedRef, ExtractRefsOptions } from "./refs.js";

// Phase B — extension definition
export { atlassianExtension } from "./extension.js";
export type { AtlassianExtensionConfig } from "./extension.js";
