/**
 * AtlassianClient — fetch-based REST client for Jira + Confluence Cloud.
 *
 * Auth: HTTP Basic with base64(email:token) per Atlassian Cloud docs.
 * Credentials are injected from outside (env); never hardcoded here.
 *
 * All requests carry a 15-second AbortSignal.timeout so a hung upstream
 * cannot stall the triage pass indefinitely.
 */

export interface AtlassianClientConfig {
  /** e.g. "https://diligentbrands.atlassian.net" */
  baseUrl: string;
  /** Atlassian account email */
  email: string;
  /** Atlassian API token — from ATLASSIAN_API_TOKEN env, never hardcoded */
  token: string;
  /** Per-request timeout in ms (default 15 000) */
  timeoutMs?: number;
}

/** Normalized error returned when an API call fails. */
export interface AtlassianError {
  ok: false;
  status: number;
  message: string;
}

export interface AttachmentBytes {
  bytes: Uint8Array;
  contentType: string;
}

export type AtlassianResult<T> = T | AtlassianError;

function isError(v: unknown): v is AtlassianError {
  return typeof v === "object" && v !== null && (v as AtlassianError).ok === false;
}
export { isError as isAtlassianError };

/** Raw Jira issue response (only the fields we consume). */
export interface RawJiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    issuetype: { name: string };
    labels: string[];
    description?: unknown;
    comment?: {
      comments: Array<{
        author: { displayName: string };
        created: string;
        renderedBody?: string;
        body?: unknown;
      }>;
    };
    attachment?: Array<{
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      content: string;
    }>;
    changelog?: unknown;
    [key: string]: unknown;
  };
  renderedFields?: {
    description?: string;
    comment?: {
      comments: Array<{ renderedBody?: string; [key: string]: unknown }>;
    };
    [key: string]: unknown;
  };
  changelog?: {
    histories: Array<{
      author: { displayName: string };
      created: string;
      items: Array<{ field: string; fromString: string | null; toString: string | null }>;
    }>;
  };
}

/** Raw Confluence page (v2 API). */
export interface RawConfluencePage {
  id: string;
  title: string;
  _links?: { webui?: string; [key: string]: unknown };
  body?: {
    view?: { value: string };
    [key: string]: unknown;
  };
  version?: { number: number; createdAt?: string; authorId?: string };
  metadata?: { labels?: { results: Array<{ name: string }> } };
}

// ---------------------------------------------------------------------------
// Confluence secondary v2 endpoint shapes
// ---------------------------------------------------------------------------

/**
 * Response from GET /wiki/api/v2/pages/{id}/labels
 * https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/#api-pages-id-labels-get
 */
export interface RawConfluencePageLabels {
  results: Array<{
    id: string;
    prefix: string;
    name: string;
  }>;
}

/**
 * Response from GET /wiki/api/v2/pages/{id}/footer-comments
 * https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-footer-comment/#api-pages-id-footer-comments-get
 */
export interface RawConfluencePageComments {
  results: Array<{
    id: string;
    version?: {
      createdAt?: string;
      author?: { displayName?: string; publicName?: string };
    };
    body?: {
      view?: { value: string };
      [key: string]: unknown;
    };
  }>;
}

/**
 * Response from GET /wiki/api/v2/pages/{id}/attachments
 * https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/#api-pages-id-attachments-get
 */
export interface RawConfluencePageAttachments {
  results: Array<{
    id: string;
    title: string;
    mediaType: string;
    fileSize: number;
    downloadLink?: string;
  }>;
}

/** Raw Confluence search hit. */
export interface RawConfluenceSearchResult {
  results: Array<{
    content?: { id: string; title: string; type: string; _links?: { webui?: string } };
    resultGlobalContainer?: { displayUrl?: string };
    [key: string]: unknown;
  }>;
}

/** Raw Jira search response. */
export interface RawJiraSearchResult {
  issues: Array<{
    key: string;
    fields: { summary: string; status: { name: string }; issuetype: { name: string } };
  }>;
}

export class AtlassianClient {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: AtlassianClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 15_000;
    // Basic auth: base64(email:token) — Q4
    this.authHeader =
      "Basic " + Buffer.from(`${config.email}:${config.token}`).toString("base64");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async get<T>(path: string): Promise<AtlassianResult<T>> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<AtlassianResult<T>> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<AtlassianResult<T>> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, message };
    }

    if (!res.ok) {
      let message = res.statusText;
      try {
        const text = await res.text();
        // Atlassian error bodies often have `errorMessages` or `message`
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (Array.isArray(parsed["errorMessages"]) && (parsed["errorMessages"] as unknown[]).length > 0) {
          message = (parsed["errorMessages"] as string[]).join("; ");
        } else if (typeof parsed["message"] === "string") {
          message = parsed["message"];
        } else {
          message = text.slice(0, 200);
        }
      } catch {
        // ignore parse errors
      }
      return { ok: false, status: res.status, message };
    }

    try {
      return (await res.json()) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : "JSON parse failed";
      return { ok: false, status: res.status, message };
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch a Jira issue by key (e.g. "PROJ-123").
   * `expand` defaults to `renderedFields` for HTML body; pass `"renderedFields,changelog"`
   * for history.
   */
  getIssue(
    key: string,
    expand = "renderedFields",
  ): Promise<AtlassianResult<RawJiraIssue>> {
    return this.get<RawJiraIssue>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?expand=${encodeURIComponent(expand)}`,
    );
  }

  /**
   * Search Jira via JQL.
   * Uses POST /rest/api/3/search/jql (avoids URL-length issues with complex JQL).
   */
  searchJira(
    jql: string,
    limit = 10,
  ): Promise<AtlassianResult<RawJiraSearchResult>> {
    return this.post<RawJiraSearchResult>("/rest/api/3/search/jql", {
      jql,
      maxResults: limit,
      fields: ["summary", "status", "issuetype"],
    });
  }

  /**
   * Fetch a Confluence page by numeric ID.
   * Uses v2 API with `body-format=view` for rendered HTML.
   */
  getPage(id: string): Promise<AtlassianResult<RawConfluencePage>> {
    return this.get<RawConfluencePage>(
      `/wiki/api/v2/pages/${encodeURIComponent(id)}?body-format=view`,
    );
  }

  /**
   * Search Confluence via CQL.
   */
  searchConfluence(
    cql: string,
    limit = 10,
  ): Promise<AtlassianResult<RawConfluenceSearchResult>> {
    const params = new URLSearchParams({ cql, limit: String(limit) });
    return this.get<RawConfluenceSearchResult>(`/wiki/rest/api/search?${params.toString()}`);
  }

  // ---------------------------------------------------------------------------
  // Confluence secondary v2 endpoints
  // ---------------------------------------------------------------------------

  /**
   * Fetch labels for a Confluence page (v2).
   * GET /wiki/api/v2/pages/{id}/labels
   */
  getPageLabels(id: string): Promise<AtlassianResult<RawConfluencePageLabels>> {
    return this.get<RawConfluencePageLabels>(
      `/wiki/api/v2/pages/${encodeURIComponent(id)}/labels`,
    );
  }

  /**
   * Fetch footer comments for a Confluence page (v2).
   * GET /wiki/api/v2/pages/{id}/footer-comments?body-format=view
   *
   * `body-format=view` is required to populate `body.view.value` with
   * rendered HTML. Without it the body object is absent and bodyMarkdown
   * collapses to an empty string.
   *
   * As-built deviation: Confluence v2 footer-comments return `version.author`
   * as `{ displayName?, publicName? }` when the account is accessible, but
   * in practice the v2 API may only surface an `authorId` (account UUID).
   * Comments may therefore show a raw account ID rather than a display name.
   * Full display-name resolution (via GET /wiki/api/v2/users/{id}) is deferred.
   */
  getPageFooterComments(id: string): Promise<AtlassianResult<RawConfluencePageComments>> {
    return this.get<RawConfluencePageComments>(
      `/wiki/api/v2/pages/${encodeURIComponent(id)}/footer-comments?body-format=view`,
    );
  }

  /**
   * Fetch attachments for a Confluence page (v2).
   * GET /wiki/api/v2/pages/{id}/attachments
   */
  getPageAttachments(id: string): Promise<AtlassianResult<RawConfluencePageAttachments>> {
    return this.get<RawConfluencePageAttachments>(
      `/wiki/api/v2/pages/${encodeURIComponent(id)}/attachments`,
    );
  }

  /**
   * Download raw attachment bytes from the given URL.
   * The URL is typically the `content` field of a Jira attachment or an equivalent
   * Confluence download URL — both require the same Basic auth.
   */
  async getAttachmentBytes(url: string): Promise<AtlassianResult<AttachmentBytes>> {
    const init: RequestInit = {
      method: "GET",
      headers: { Authorization: this.authHeader },
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, message };
    }

    if (!res.ok) {
      return { ok: false, status: res.status, message: res.statusText };
    }

    try {
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const buf = await res.arrayBuffer();
      return { bytes: new Uint8Array(buf), contentType };
    } catch (err) {
      const message = err instanceof Error ? err.message : "read failed";
      return { ok: false, status: res.status, message };
    }
  }
}
