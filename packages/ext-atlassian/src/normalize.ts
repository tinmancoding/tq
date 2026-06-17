/**
 * normalize.ts — map raw Jira/Confluence API payloads to the model-ready
 * normalized shape documented in design §2.2.
 *
 * `include` flags control which optional sections are populated:
 *   - "comments"     → include comments array
 *   - "attachments"  → include attachment metadata array
 *   - "history"      → include history array (Jira changelog / Confluence versions)
 */

import type { RawJiraIssue, RawConfluencePage, RawJiraSearchResult, RawConfluenceSearchResult } from "./client.js";
import { htmlToMarkdown, truncate } from "./shape.js";

export type IncludeFlag = "comments" | "attachments" | "history";

/** Normalized shape for a Jira issue (design §2.2). */
export interface NormalizedIssue {
  ref: string;
  url: string;
  title: string;
  status: string;
  type: string;
  labels: string[];
  bodyMarkdown: string;
  comments?: Array<{ author: string; when: string; bodyMarkdown: string }>;
  attachments?: Array<{ id: string; filename: string; mime: string; size: number; downloadUrl: string }>;
  history?: Array<{ author: string; when: string; summary: string }>;
}

/** Normalized shape for a Confluence page (design §2.2). */
export interface NormalizedPage {
  ref: string;
  url: string;
  title: string;
  labels: string[];
  bodyMarkdown: string;
  comments?: Array<{ author: string; when: string; bodyMarkdown: string }>;
  attachments?: Array<{ id: string; filename: string; mime: string; size: number; downloadUrl: string }>;
  history?: Array<{ author: string; when: string; summary: string }>;
}

/** Slim hit shapes for search results. */
export interface JiraSearchHit {
  key: string;
  summary: string;
  status: string;
  type: string;
}

export interface ConfluenceSearchHit {
  id: string;
  title: string;
  space: string;
  url: string;
}

const DEFAULT_BODY_MAX = 8_000;

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export function normalizeIssue(
  raw: RawJiraIssue,
  baseUrl: string,
  include: IncludeFlag[] = [],
  bodyMaxChars = DEFAULT_BODY_MAX,
): NormalizedIssue {
  const url = `${baseUrl}/browse/${raw.key}`;

  // Prefer the pre-rendered HTML description from renderedFields; fall back to
  // raw fields.description which may be Atlassian Document Format (ADF object).
  const rawHtml =
    typeof raw.renderedFields?.["description"] === "string"
      ? (raw.renderedFields["description"] as string)
      : null;
  const bodyMarkdown = truncate(htmlToMarkdown(rawHtml), bodyMaxChars);

  const result: NormalizedIssue = {
    ref: raw.key,
    url,
    title: raw.fields.summary,
    status: raw.fields.status.name,
    type: raw.fields.issuetype.name,
    labels: raw.fields.labels ?? [],
    bodyMarkdown,
  };

  if (include.includes("comments")) {
    const rendered = raw.renderedFields?.["comment"];
    const rawComments =
      rendered && typeof rendered === "object" && "comments" in rendered
        ? (rendered as { comments: Array<{ renderedBody?: string; [key: string]: unknown }> }).comments
        : raw.fields.comment?.comments ?? [];

    result.comments = rawComments.map((c, i) => {
      const bodyHtml =
        typeof c["renderedBody"] === "string" ? c["renderedBody"] : "";
      const rawC = raw.fields.comment?.comments[i];
      return {
        author: rawC?.author?.displayName ?? "unknown",
        when: rawC?.created ?? "",
        bodyMarkdown: truncate(htmlToMarkdown(bodyHtml), 2_000),
      };
    });
  }

  if (include.includes("attachments")) {
    result.attachments = (raw.fields.attachment ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      mime: a.mimeType,
      size: a.size,
      downloadUrl: a.content,
    }));
  }

  if (include.includes("history")) {
    const histories = raw.changelog?.histories ?? [];
    // Last 10 entries
    result.history = histories.slice(-10).map((h) => ({
      author: h.author.displayName,
      when: h.created,
      summary: h.items
        .map((it) => `${it.field}: ${it.fromString ?? "—"} → ${it.toString ?? "—"}`)
        .join("; "),
    }));
  }

  return result;
}

export function normalizeJiraSearchResults(raw: RawJiraSearchResult): JiraSearchHit[] {
  return raw.issues.map((i) => ({
    key: i.key,
    summary: i.fields.summary,
    status: i.fields.status.name,
    type: i.fields.issuetype.name,
  }));
}

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

export function normalizePage(
  raw: RawConfluencePage,
  baseUrl: string,
  include: IncludeFlag[] = [],
  bodyMaxChars = DEFAULT_BODY_MAX,
): NormalizedPage {
  const webui = raw._links?.["webui"] ?? "";
  const url = webui.startsWith("http") ? webui : `${baseUrl}/wiki${webui}`;

  const rawHtml = raw.body?.view?.value ?? "";
  const bodyMarkdown = truncate(htmlToMarkdown(rawHtml), bodyMaxChars);

  const labels = raw.metadata?.labels?.results.map((l) => l.name) ?? [];

  const result: NormalizedPage = {
    ref: raw.id,
    url,
    title: raw.title,
    labels,
    bodyMarkdown,
  };

  // Empty-array defaults; the gateway handler (`extension.ts`) overwrites these
  // via secondary v2 calls when the corresponding include flag is set.
  // Returning empty arrays here (rather than undefined) keeps the shape consistent
  // for callers that don't use include flags.
  if (include.includes("comments")) {
    result.comments = [];
  }
  if (include.includes("attachments")) {
    result.attachments = [];
  }
  if (include.includes("history")) {
    // As-built deviation: Confluence v2 page GET returns `version.authorId`
    // (an account UUID) rather than a display name. Real data will show a raw
    // account ID here. Full display-name resolution via
    // GET /wiki/api/v2/users/{id} is deferred; the graceful fallback to
    // "unknown" is retained.
    if (raw.version) {
      result.history = [
        {
          author: raw.version.authorId ?? "unknown",
          when: raw.version.createdAt ?? "",
          summary: `version ${raw.version.number}`,
        },
      ];
    } else {
      result.history = [];
    }
  }

  return result;
}

export function normalizeConfluenceSearchResults(
  raw: RawConfluenceSearchResult,
  baseUrl: string,
): ConfluenceSearchHit[] {
  return raw.results.map((r) => {
    const content = r["content"];
    const id = content?.id ?? "";
    const title = content?.title ?? "";
    const webui = content?._links?.["webui"] ?? r["resultGlobalContainer"]?.["displayUrl"] ?? "";
    const url = webui.startsWith("http") ? webui : `${baseUrl}/wiki${webui}`;
    // Space is not always present in the v1 search result; derive from URL or leave empty.
    return { id, title, space: "", url };
  });
}
