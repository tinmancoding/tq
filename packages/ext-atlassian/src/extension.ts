/**
 * extension.ts — Phase B: atlassianExtension({ client, config })
 *
 * Wraps the AtlassianClient in a defineExtension and registers read-only
 * gateway endpoints under /api/ext/atlassian/*  (design §2.2, plan §2).
 *
 * All routes are GET-only. No create/edit/transition operations are exposed.
 * Credentials never flow through the response.
 */

import {
  defineExtension,
  type ExtensionContext,
  type ExtensionDefinition,
  type ExtRequest,
  type ExtResponse,
} from "@tq/extension-sdk";
import {
  AtlassianClient,
  isAtlassianError,
  type AtlassianError,
} from "./client.js";
import {
  normalizeIssue,
  normalizePage,
  normalizeJiraSearchResults,
  normalizeConfluenceSearchResults,
  type IncludeFlag,
} from "./normalize.js";
import { htmlToMarkdown, truncate } from "./shape.js";
import { preprocessAttachment } from "./attachment.js";

// ---------------------------------------------------------------------------
// Public config + types
// ---------------------------------------------------------------------------

export interface AtlassianExtensionConfig {
  /** e.g. "https://diligentbrands.atlassian.net" */
  baseUrl?: string;
  /** Max characters for body markdown (default 8 000) */
  bodyMarkdownMaxChars?: number;
  /** Max bytes for attachment downloads (default 25 MiB) */
  attachmentMaxBytes?: number;
}

/** All flags parseable from the `?include=` query param. */
type AllIncludeFlag = IncludeFlag | "labels";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a query parameter value that TypeScript types as `string | undefined`
 * but Fastify may deliver as `string[]` at runtime (repeated param names).
 * Returns the first element for arrays, empty string for undefined.
 */
function coerceString(v: unknown): string {
  if (Array.isArray(v)) return (v[0] as string | undefined) ?? "";
  return typeof v === "string" ? v : "";
}

/**
 * Parse `?include=comments,attachments,history,labels` into a set of flags.
 * Unknown tokens are silently dropped.
 */
function parseInclude(query: Record<string, string | undefined>): AllIncludeFlag[] {
  const raw = coerceString(query["include"]);
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is AllIncludeFlag =>
      ["comments", "attachments", "history", "labels"].includes(s),
    );
}

/** Convert an AtlassianError to an ExtResponse with the matching status code. */
function errorResponse(err: AtlassianError): ExtResponse {
  return {
    status: err.status >= 100 ? err.status : 502,
    body: { error: err.message },
  };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Create the Atlassian read-only gateway extension.
 *
 * @param opts.client   A fully-configured AtlassianClient.
 * @param opts.config   Optional per-deployment overrides.
 */
export function atlassianExtension(opts: {
  client: AtlassianClient;
  config?: AtlassianExtensionConfig;
}): ExtensionDefinition {
  return defineExtension({
    name: "atlassian",
    setup: (ctx: ExtensionContext) => {
      const { client } = opts;
      const baseUrl = opts.config?.baseUrl ?? "https://diligentbrands.atlassian.net";
      const bodyMaxChars = opts.config?.bodyMarkdownMaxChars ?? 8_000;
      const attachmentMaxBytes = opts.config?.attachmentMaxBytes ?? 26_214_400; // 25 MiB

      // -----------------------------------------------------------------------
      // GET /health — readiness probe for the triage connector (Phase D)
      // -----------------------------------------------------------------------
      ctx.route({
        method: "GET",
        path: "/health",
        handler: (): ExtResponse => ({
          status: 200,
          body: { ok: true, connector: "atlassian" },
        }),
      });

      // -----------------------------------------------------------------------
      // GET /jira/:key?include=comments,attachments,history
      // -----------------------------------------------------------------------
      ctx.route({
        method: "GET",
        path: "/jira/:key",
        handler: async (req: ExtRequest): Promise<ExtResponse> => {
          const key = req.params["key"];
          if (!key) return { status: 400, body: { error: "missing key" } };

          const include = parseInclude(req.query);
          // Request changelog expansion only when history is requested
          const expand = include.includes("history")
            ? "renderedFields,changelog"
            : "renderedFields";

          const raw = await client.getIssue(key, expand);
          if (isAtlassianError(raw)) return errorResponse(raw);

          // IncludeFlag subset (exclude "labels" which isn't a normalizeIssue flag)
          const normalizeFlags = include.filter(
            (f): f is IncludeFlag => f !== "labels",
          );
          const issue = normalizeIssue(raw, baseUrl, normalizeFlags, bodyMaxChars);
          return { status: 200, body: issue };
        },
      });

      // -----------------------------------------------------------------------
      // GET /jira/search?jql=…&limit=
      // -----------------------------------------------------------------------
      ctx.route({
        method: "GET",
        path: "/jira/search",
        handler: async (req: ExtRequest): Promise<ExtResponse> => {
          const jql = coerceString(req.query["jql"]);
          if (!jql.trim()) return { status: 400, body: { error: "jql is required" } };
          const limitRaw = coerceString(req.query["limit"]);
          const limit = limitRaw ? Number(limitRaw) : 10;

          const raw = await client.searchJira(jql, limit);
          if (isAtlassianError(raw)) return errorResponse(raw);

          return { status: 200, body: { hits: normalizeJiraSearchResults(raw) } };
        },
      });

      // -----------------------------------------------------------------------
      // GET /confluence/:id?include=comments,attachments,history,labels
      //
      // Phase B wires the secondary v2 calls that were deferred in Phase A:
      //   labels       → GET /wiki/api/v2/pages/{id}/labels
      //   comments     → GET /wiki/api/v2/pages/{id}/footer-comments
      //                  NOTE: inline-comments are a separate v2 endpoint
      //                  (/wiki/api/v2/pages/{id}/inline-comments); those are
      //                  not fetched here — wire in a later phase if needed.
      //   attachments  → GET /wiki/api/v2/pages/{id}/attachments
      // -----------------------------------------------------------------------
      ctx.route({
        method: "GET",
        path: "/confluence/:id",
        handler: async (req: ExtRequest): Promise<ExtResponse> => {
          const id = req.params["id"];
          if (!id) return { status: 400, body: { error: "missing id" } };

          const include = parseInclude(req.query);

          const raw = await client.getPage(id);
          if (isAtlassianError(raw)) return errorResponse(raw);

          // normalizeFlags excludes "labels" (handled separately below)
          const normalizeFlags = include.filter(
            (f): f is IncludeFlag => f !== "labels",
          );
          const page = normalizePage(raw, baseUrl, normalizeFlags, bodyMaxChars);

          // --- Labels (secondary v2 call) ---
          if (include.includes("labels")) {
            const labelsResult = await client.getPageLabels(id);
            if (!isAtlassianError(labelsResult)) {
              page.labels = labelsResult.results.map((l) => l.name);
            }
            // On error we keep the (possibly empty) labels from normalizePage
          }

          // --- Comments (footer-comments via secondary v2 call) ---
          // Inline comments are a separate endpoint (/wiki/api/v2/pages/{id}/inline-comments)
          // and are NOT fetched here; the array will only contain footer-comments.
          if (include.includes("comments")) {
            const commentsResult = await client.getPageFooterComments(id);
            if (!isAtlassianError(commentsResult)) {
              page.comments = commentsResult.results.map((c) => {
                const bodyHtml = c.body?.view?.value ?? "";
                return {
                  author:
                    c.version?.author?.displayName ??
                    c.version?.author?.publicName ??
                    "unknown",
                  when: c.version?.createdAt ?? "",
                  bodyMarkdown: truncate(htmlToMarkdown(bodyHtml), 2_000),
                };
              });
            }
            // On error: page.comments remains [] as set by normalizePage
          }

          // --- Attachments (secondary v2 call) ---
          if (include.includes("attachments")) {
            const attachResult = await client.getPageAttachments(id);
            if (!isAtlassianError(attachResult)) {
              page.attachments = attachResult.results.map((a) => {
                const dl = a.downloadLink ?? "";
                const downloadUrl = dl.startsWith("http") ? dl : `${baseUrl}/wiki${dl}`;
                return {
                  id: a.id,
                  filename: a.title,
                  mime: a.mediaType,
                  size: a.fileSize,
                  downloadUrl,
                };
              });
            }
            // On error: page.attachments remains [] as set by normalizePage
          }

          return { status: 200, body: page };
        },
      });

      // -----------------------------------------------------------------------
      // GET /confluence/search?cql=…&limit=
      // -----------------------------------------------------------------------
      ctx.route({
        method: "GET",
        path: "/confluence/search",
        handler: async (req: ExtRequest): Promise<ExtResponse> => {
          const cql = coerceString(req.query["cql"]);
          if (!cql.trim()) return { status: 400, body: { error: "cql is required" } };
          const limitRaw = coerceString(req.query["limit"]);
          const limit = limitRaw ? Number(limitRaw) : 10;

          const raw = await client.searchConfluence(cql, limit);
          if (isAtlassianError(raw)) return errorResponse(raw);

          return {
            status: 200,
            body: { hits: normalizeConfluenceSearchResults(raw, baseUrl) },
          };
        },
      });

      // -----------------------------------------------------------------------
      // GET /attachment?ref=<url>&mimeHint=<mime-or-filename>
      //
      // Downloads attachment bytes from the given URL (which carries Basic auth),
      // preprocesses them (resize image / extract text / PDF text extraction),
      // and returns { text?, images?: [{mime, dataBase64}] }.
      //
      // `ref` is the full download URL of the attachment (e.g. the `content`
      // field on a Jira attachment or the `downloadLink` on a Confluence attachment).
      // `mimeHint` is an optional mime type or filename hint (e.g. 'image/png',
      // 'application/pdf', 'report.pdf'). When absent or not a mime type, the
      // handler falls back to the Content-Type from the download response.
      // -----------------------------------------------------------------------
      ctx.route({
        method: "GET",
        path: "/attachment",
        handler: async (req: ExtRequest): Promise<ExtResponse> => {
          const ref = coerceString(req.query["ref"]);
          if (!ref) return { status: 400, body: { error: "ref is required" } };

          // Validate it looks like a URL
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(ref);
          } catch {
            return { status: 400, body: { error: "ref must be a valid URL" } };
          }

          // SECURITY: Only allow download from the configured Atlassian instance.
          // The ref comes from attachment metadata which may eventually originate
          // from untrusted content (Phase D). Sending the Basic-auth credential
          // to an arbitrary origin would exfiltrate it.
          const allowedOrigin = new URL(baseUrl).origin;
          if (parsedUrl.origin !== allowedOrigin) {
            return {
              status: 403,
              body: {
                error: `attachment ref origin '${parsedUrl.origin}' is not the configured Atlassian instance ('${allowedOrigin}'); download refused`,
              },
            };
          }

          const bytesResult = await client.getAttachmentBytes(ref);
          if (isAtlassianError(bytesResult)) return errorResponse(bytesResult);

          // Enforce max-size guard
          if (bytesResult.bytes.byteLength > attachmentMaxBytes) {
            return {
              status: 413,
              body: {
                error: `attachment exceeds size limit (${bytesResult.bytes.byteLength} > ${attachmentMaxBytes} bytes)`,
              },
            };
          }

          // Derive mime from `mimeHint` query param (e.g. 'image/png', 'application/pdf').
          // If the hint doesn't look like a mime type, fall back to the Content-Type
          // returned by the download response, then to 'application/octet-stream'.
          const mimeHint = coerceString(req.query["mimeHint"]);
          const mime = mimeHint.includes("/") ? mimeHint : (bytesResult.contentType || "application/octet-stream");
          // Filename hint: use the last path segment of ref
          const filename = ref.split("/").pop()?.split("?")[0];

          const preprocessed = await preprocessAttachment(bytesResult.bytes, mime, filename);
          return { status: 200, body: preprocessed };
        },
      });
    },
  });
}
