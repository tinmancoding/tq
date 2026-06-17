/**
 * extension.test.ts — Phase B gateway endpoint tests.
 *
 * Uses a lightweight mock ExtensionContext (no @tq/core, no daemon) that
 * captures registered routes and invokes handlers directly. The AtlassianClient
 * methods are all mocked via vi.spyOn, so no live network calls are made.
 *
 * This mirrors the "in-memory harness" spirit of triage-extension.test.ts:
 * we call setup(), collect the registered routes, then send synthetic ExtRequest
 * objects and assert on the returned ExtResponse.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtRequest, ExtResponse, ExtRoute, ExtensionContext } from "@tq/extension-sdk";
import { AtlassianClient, isAtlassianError } from "../client.js";
import { atlassianExtension } from "../extension.js";
import type {
  RawJiraIssue,
  RawConfluencePage,
  RawJiraSearchResult,
  RawConfluenceSearchResult,
  RawConfluencePageLabels,
  RawConfluencePageComments,
  RawConfluencePageAttachments,
} from "../client.js";

// ---------------------------------------------------------------------------
// Minimal in-process harness
// ---------------------------------------------------------------------------

type Handler = (req: ExtRequest) => ExtResponse | Promise<ExtResponse>;

/** Build a mock ExtensionContext, return it together with a route dispatcher. */
function buildHarness(client: AtlassianClient) {
  const routes = new Map<string, Handler>(); // "METHOD:/path" → handler

  const ctx: ExtensionContext = {
    name: "atlassian",
    core: {} as ExtensionContext["core"],
    config: {},
    log: vi.fn(),
    on: vi.fn(),
    onAny: vi.fn(),
    route: vi.fn((r: ExtRoute) => {
      routes.set(`${r.method}:${r.path}`, r.handler as Handler);
    }),
  };

  const ext = atlassianExtension({ client, config: { baseUrl: "https://test.atlassian.net" } });
  // setup is synchronous for this extension
  void ext.setup(ctx);

  /**
   * Dispatch a synthetic request to the registered handler.
   * `path` uses the registered route key (including Fastify-style :params),
   * or we match it by comparing the route key to the path.
   */
  async function dispatch(
    method: string,
    routePath: string,
    params: Record<string, string> = {},
    query: Record<string, string | undefined> = {},
    body: unknown = null,
  ): Promise<ExtResponse> {
    const key = `${method}:${routePath}`;
    const handler = routes.get(key);
    if (!handler) throw new Error(`No route registered for ${key}. Registered: ${[...routes.keys()].join(", ")}`);
    const req: ExtRequest = {
      method,
      path: routePath,
      params,
      query,
      headers: {},
      body,
    };
    return handler(req);
  }

  return { ctx, routes, dispatch };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRawIssue(key = "PROJ-1"): RawJiraIssue {
  return {
    id: "10001",
    key,
    fields: {
      summary: "Test issue",
      status: { name: "In Progress" },
      issuetype: { name: "Bug" },
      labels: ["backend"],
      comment: {
        comments: [
          {
            author: { displayName: "Alice" },
            created: "2024-01-01T10:00:00.000Z",
            renderedBody: "<p>A comment</p>",
          },
        ],
      },
      attachment: [
        { id: "att1", filename: "screenshot.png", mimeType: "image/png", size: 1024, content: "https://test.atlassian.net/attach/att1" },
      ],
    },
    renderedFields: {
      description: "<p>This is the description</p>",
      comment: {
        comments: [{ renderedBody: "<p>A comment</p>" }],
      },
    },
    changelog: {
      histories: [
        {
          author: { displayName: "Bob" },
          created: "2024-01-02T10:00:00.000Z",
          items: [{ field: "status", fromString: "Open", toString: "In Progress" }],
        },
      ],
    },
  };
}

function makeRawPage(id = "12345"): RawConfluencePage {
  return {
    id,
    title: "Test Page",
    _links: { webui: "/wiki/spaces/ENG/pages/12345/Test-Page" },
    body: { view: { value: "<h1>Hello</h1><p>Content here</p>" } },
    version: { number: 3, createdAt: "2024-01-10T00:00:00.000Z", authorId: "user123" },
    metadata: { labels: { results: [{ name: "architecture" }] } },
  };
}

function makeRawJiraSearch(): RawJiraSearchResult {
  return {
    issues: [
      { key: "PROJ-1", fields: { summary: "Bug in login", status: { name: "Open" }, issuetype: { name: "Bug" } } },
      { key: "PROJ-2", fields: { summary: "Feature request", status: { name: "Done" }, issuetype: { name: "Story" } } },
    ],
  };
}

function makeRawConfluenceSearch(): RawConfluenceSearchResult {
  return {
    results: [
      {
        content: {
          id: "99999",
          title: "Design Doc",
          type: "page",
          _links: { webui: "/wiki/spaces/ARCH/pages/99999/Design-Doc" },
        },
      },
    ],
  };
}

function makeRawLabels(): RawConfluencePageLabels {
  return { results: [{ id: "l1", prefix: "global", name: "architecture" }] };
}

function makeRawComments(): RawConfluencePageComments {
  return {
    results: [
      {
        id: "c1",
        version: {
          createdAt: "2024-03-01T12:00:00.000Z",
          author: { displayName: "Charlie" },
        },
        body: { view: { value: "<p>Great page!</p>" } },
      },
    ],
  };
}

function makeRawAttachments(): RawConfluencePageAttachments {
  return {
    results: [
      {
        id: "a1",
        title: "diagram.png",
        mediaType: "image/png",
        fileSize: 2048,
        downloadLink: "https://test.atlassian.net/wiki/download/a1",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): AtlassianClient {
  return new AtlassianClient({
    baseUrl: "https://test.atlassian.net",
    email: "user@example.com",
    token: "test-token",
  });
}

function atlassianError(status: number, message: string) {
  return { ok: false as const, status, message };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("atlassianExtension (Phase B gateway routes)", () => {
  let client: AtlassianClient;

  beforeEach(() => {
    client = makeClient();
    // Guard: any unmocked fetch path throws loudly instead of hitting the real network.
    // Individual tests that need fetch (e.g. attachment preprocessing) use vi.spyOn
    // on the client methods directly, so this never fires for properly-mocked tests.
    vi.stubGlobal("fetch", () => {
      throw new Error(
        "[test guard] unmocked fetch call — stub client methods with vi.spyOn instead of letting them reach the network",
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Extension setup / meta
  // -------------------------------------------------------------------------

  it("registers an extension with name 'atlassian'", () => {
    const ext = atlassianExtension({ client });
    expect(ext.name).toBe("atlassian");
  });

  it("registers all expected routes", () => {
    const { routes } = buildHarness(client);
    expect(routes.has("GET:/health")).toBe(true);
    expect(routes.has("GET:/jira/:key")).toBe(true);
    expect(routes.has("GET:/jira/search")).toBe(true);
    expect(routes.has("GET:/confluence/:id")).toBe(true);
    expect(routes.has("GET:/confluence/search")).toBe(true);
    expect(routes.has("GET:/attachment")).toBe(true);
  });

  it("registers exactly 6 routes (all GET, none write)", () => {
    const { routes } = buildHarness(client);
    expect(routes.size).toBe(6);
    for (const key of routes.keys()) {
      expect(key.startsWith("GET:")).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  describe("GET /health", () => {
    it("returns 200 ok", async () => {
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/health");
      expect(res.status).toBe(200);
      expect((res.body as { ok: boolean }).ok).toBe(true);
      expect((res.body as { connector: string }).connector).toBe("atlassian");
    });
  });

  // -------------------------------------------------------------------------
  // GET /jira/:key
  // -------------------------------------------------------------------------

  describe("GET /jira/:key", () => {
    it("returns normalized issue shape", async () => {
      vi.spyOn(client, "getIssue").mockResolvedValue(makeRawIssue("AIBM-42"));
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/jira/:key", { key: "AIBM-42" });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body["ref"]).toBe("AIBM-42");
      expect(body["title"]).toBe("Test issue");
      expect(body["status"]).toBe("In Progress");
      expect(body["type"]).toBe("Bug");
      expect(body["labels"]).toEqual(["backend"]);
      expect(typeof body["bodyMarkdown"]).toBe("string");
    });

    it("returns comments when include=comments", async () => {
      vi.spyOn(client, "getIssue").mockResolvedValue(makeRawIssue());
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/jira/:key", { key: "PROJ-1" }, { include: "comments" });

      const body = res.body as Record<string, unknown>;
      const comments = body["comments"] as Array<{ author: string; when: string; bodyMarkdown: string }>;
      expect(Array.isArray(comments)).toBe(true);
      expect(comments.length).toBeGreaterThan(0);
      expect(comments[0]?.author).toBe("Alice");
    });

    it("returns attachments metadata when include=attachments", async () => {
      vi.spyOn(client, "getIssue").mockResolvedValue(makeRawIssue());
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/jira/:key", { key: "PROJ-1" }, { include: "attachments" });

      const body = res.body as Record<string, unknown>;
      const attachments = body["attachments"] as Array<{ id: string; filename: string }>;
      expect(Array.isArray(attachments)).toBe(true);
      expect(attachments[0]?.filename).toBe("screenshot.png");
      expect(attachments[0]?.id).toBe("att1");
    });

    it("returns history when include=history", async () => {
      vi.spyOn(client, "getIssue").mockResolvedValue(makeRawIssue());
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/jira/:key", { key: "PROJ-1" }, { include: "history" });

      const body = res.body as Record<string, unknown>;
      const history = body["history"] as Array<{ author: string; summary: string }>;
      expect(Array.isArray(history)).toBe(true);
      expect(history[0]?.author).toBe("Bob");
      expect(history[0]?.summary).toContain("status");
    });

    it("does not include comments/attachments/history without include flag", async () => {
      vi.spyOn(client, "getIssue").mockResolvedValue(makeRawIssue());
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/jira/:key", { key: "PROJ-1" });

      const body = res.body as Record<string, unknown>;
      expect(body["comments"]).toBeUndefined();
      expect(body["attachments"]).toBeUndefined();
      expect(body["history"]).toBeUndefined();
    });

    it("passes changelog expand to client when include=history", async () => {
      const spy = vi.spyOn(client, "getIssue").mockResolvedValue(makeRawIssue());
      const { dispatch } = buildHarness(client);

      await dispatch("GET", "/jira/:key", { key: "PROJ-1" }, { include: "history" });

      expect(spy).toHaveBeenCalledWith("PROJ-1", "renderedFields,changelog");
    });

    it("returns 400 when key is missing", async () => {
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/jira/:key", {});
      expect(res.status).toBe(400);
    });

    it("returns 4xx with error message when client returns error", async () => {
      vi.spyOn(client, "getIssue").mockResolvedValue(atlassianError(404, "Issue not found"));
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/jira/:key", { key: "PROJ-999" });

      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toBe("Issue not found");
    });

    it("returns 502 for status-0 network errors", async () => {
      vi.spyOn(client, "getIssue").mockResolvedValue(atlassianError(0, "ECONNREFUSED"));
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/jira/:key", { key: "PROJ-1" });

      expect(res.status).toBe(502);
      expect((res.body as { error: string }).error).toContain("ECONNREFUSED");
    });
  });

  // -------------------------------------------------------------------------
  // GET /jira/search
  // -------------------------------------------------------------------------

  describe("GET /jira/search", () => {
    it("returns normalized hits array", async () => {
      vi.spyOn(client, "searchJira").mockResolvedValue(makeRawJiraSearch());
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/jira/search", {}, { jql: "project = PROJ" });

      expect(res.status).toBe(200);
      const body = res.body as { hits: unknown[] };
      expect(Array.isArray(body.hits)).toBe(true);
      expect(body.hits).toHaveLength(2);
      expect((body.hits[0] as { key: string }).key).toBe("PROJ-1");
    });

    it("returns 400 when jql is missing", async () => {
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/jira/search", {}, {});
      expect(res.status).toBe(400);
    });

    it("forwards client errors as 4xx/5xx", async () => {
      vi.spyOn(client, "searchJira").mockResolvedValue(atlassianError(400, "Invalid JQL"));
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/jira/search", {}, { jql: "bad jql %%%" });

      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe("Invalid JQL");
    });
  });

  // -------------------------------------------------------------------------
  // GET /confluence/:id
  // -------------------------------------------------------------------------

  describe("GET /confluence/:id", () => {
    it("returns normalized page shape", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/:id", { id: "12345" });

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body["ref"]).toBe("12345");
      expect(body["title"]).toBe("Test Page");
      expect(typeof body["bodyMarkdown"]).toBe("string");
      expect((body["bodyMarkdown"] as string).length).toBeGreaterThan(0);
    });

    it("fetches labels via secondary v2 call when include=labels", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      const labelsSpy = vi.spyOn(client, "getPageLabels").mockResolvedValue(makeRawLabels());
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/:id", { id: "12345" }, { include: "labels" });

      expect(labelsSpy).toHaveBeenCalledWith("12345");
      const body = res.body as Record<string, unknown>;
      expect(body["labels"]).toEqual(["architecture"]);
    });

    it("fetches footer-comments via secondary v2 call when include=comments", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      const commentsSpy = vi.spyOn(client, "getPageFooterComments").mockResolvedValue(makeRawComments());
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/:id", { id: "12345" }, { include: "comments" });

      expect(commentsSpy).toHaveBeenCalledWith("12345");
      const body = res.body as Record<string, unknown>;
      const comments = body["comments"] as Array<{ author: string; when: string; bodyMarkdown: string }>;
      expect(Array.isArray(comments)).toBe(true);
      expect(comments[0]?.author).toBe("Charlie");
      expect(comments[0]?.when).toBe("2024-03-01T12:00:00.000Z");
      expect(typeof comments[0]?.bodyMarkdown).toBe("string");
    });

    it("fetches attachments via secondary v2 call when include=attachments", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      const attachSpy = vi.spyOn(client, "getPageAttachments").mockResolvedValue(makeRawAttachments());
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/:id", { id: "12345" }, { include: "attachments" });

      expect(attachSpy).toHaveBeenCalledWith("12345");
      const body = res.body as Record<string, unknown>;
      const attachments = body["attachments"] as Array<{ id: string; filename: string; mime: string; size: number; downloadUrl: string }>;
      expect(Array.isArray(attachments)).toBe(true);
      expect(attachments[0]?.id).toBe("a1");
      expect(attachments[0]?.filename).toBe("diagram.png");
      expect(attachments[0]?.mime).toBe("image/png");
      expect(attachments[0]?.size).toBe(2048);
      expect(attachments[0]?.downloadUrl).toBe("https://test.atlassian.net/wiki/download/a1");
    });

    it("resolves relative Confluence downloadLink with /wiki prefix (not double-slash)", async () => {
      // Confluence v2 API returns relative downloadLinks like '/download/attachments/...'
      // The connector must produce 'baseUrl/wiki/download/...' not 'baseUrl/download/...'.
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      vi.spyOn(client, "getPageAttachments").mockResolvedValue({
        results: [{
          id: "rel1",
          title: "notes.txt",
          mediaType: "text/plain",
          fileSize: 500,
          downloadLink: "/download/attachments/12345/notes.txt",
        }],
      });
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/:id", { id: "12345" }, { include: "attachments" });

      const body = res.body as Record<string, unknown>;
      const atts = body["attachments"] as Array<{ downloadUrl: string }>;
      // Must be absolute and contain '/wiki/' (not double-slash)
      expect(atts[0]?.downloadUrl).toBe("https://test.atlassian.net/wiki/download/attachments/12345/notes.txt");
    });

    it("passes through absolute Confluence downloadLink unchanged", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      vi.spyOn(client, "getPageAttachments").mockResolvedValue({
        results: [{
          id: "abs1",
          title: "file.pdf",
          mediaType: "application/pdf",
          fileSize: 1024,
          downloadLink: "https://test.atlassian.net/wiki/download/attachments/12345/file.pdf",
        }],
      });
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/:id", { id: "12345" }, { include: "attachments" });

      const body = res.body as Record<string, unknown>;
      const atts = body["attachments"] as Array<{ downloadUrl: string }>;
      expect(atts[0]?.downloadUrl).toBe("https://test.atlassian.net/wiki/download/attachments/12345/file.pdf");
    });

    it("handles multiple include flags", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      vi.spyOn(client, "getPageLabels").mockResolvedValue(makeRawLabels());
      vi.spyOn(client, "getPageFooterComments").mockResolvedValue(makeRawComments());
      vi.spyOn(client, "getPageAttachments").mockResolvedValue(makeRawAttachments());
      const { dispatch } = buildHarness(client);

      const res = await dispatch(
        "GET",
        "/confluence/:id",
        { id: "12345" },
        { include: "labels,comments,attachments" },
      );

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body["labels"]).toEqual(["architecture"]);
      expect(Array.isArray(body["comments"])).toBe(true);
      expect(Array.isArray(body["attachments"])).toBe(true);
    });

    it("returns history from inline version data when include=history", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/:id", { id: "12345" }, { include: "history" });

      const body = res.body as Record<string, unknown>;
      const history = body["history"] as Array<{ summary: string }>;
      expect(Array.isArray(history)).toBe(true);
      expect(history[0]?.summary).toContain("version 3");
    });

    it("does not make secondary calls without include flags", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      const labelsSpy = vi.spyOn(client, "getPageLabels");
      const commentsSpy = vi.spyOn(client, "getPageFooterComments");
      const attachSpy = vi.spyOn(client, "getPageAttachments");
      const { dispatch } = buildHarness(client);

      await dispatch("GET", "/confluence/:id", { id: "12345" });

      expect(labelsSpy).not.toHaveBeenCalled();
      expect(commentsSpy).not.toHaveBeenCalled();
      expect(attachSpy).not.toHaveBeenCalled();
    });

    it("keeps arrays empty if secondary call fails (graceful degradation)", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(makeRawPage("12345"));
      vi.spyOn(client, "getPageFooterComments").mockResolvedValue(
        atlassianError(503, "Service unavailable"),
      );
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/:id", { id: "12345" }, { include: "comments" });

      // Page still returned successfully
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body["comments"]).toEqual([]);
    });

    it("returns 400 when id is missing", async () => {
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/confluence/:id", {});
      expect(res.status).toBe(400);
    });

    it("returns 4xx when client returns error", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(atlassianError(404, "Page not found"));
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/:id", { id: "99999" });

      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toBe("Page not found");
    });
  });

  // -------------------------------------------------------------------------
  // GET /confluence/search
  // -------------------------------------------------------------------------

  describe("GET /confluence/search", () => {
    it("returns normalized hits array", async () => {
      vi.spyOn(client, "searchConfluence").mockResolvedValue(makeRawConfluenceSearch());
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/search", {}, { cql: 'type = "page"' });

      expect(res.status).toBe(200);
      const body = res.body as { hits: unknown[] };
      expect(Array.isArray(body.hits)).toBe(true);
      expect((body.hits[0] as { id: string }).id).toBe("99999");
      expect((body.hits[0] as { title: string }).title).toBe("Design Doc");
    });

    it("returns 400 when cql is missing", async () => {
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/confluence/search", {}, {});
      expect(res.status).toBe(400);
    });

    it("forwards client errors as 4xx/5xx", async () => {
      vi.spyOn(client, "searchConfluence").mockResolvedValue(atlassianError(400, "Bad CQL syntax"));
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/confluence/search", {}, { cql: "%%%" });

      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe("Bad CQL syntax");
    });
  });

  // -------------------------------------------------------------------------
  // GET /attachment
  // -------------------------------------------------------------------------

  describe("GET /attachment", () => {
    it("returns { text } for a text attachment", async () => {
      const textBytes = new Uint8Array(Buffer.from("Hello, world!"));
      vi.spyOn(client, "getAttachmentBytes").mockResolvedValue({ bytes: textBytes, contentType: "text/plain" });
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/attachment", {}, {
        ref: "https://test.atlassian.net/attach/readme.txt",
        mimeHint: "text/plain",
      });

      expect(res.status).toBe(200);
      const body = res.body as { text?: string; images?: unknown[] };
      expect(body.text).toBe("Hello, world!");
      expect(body.images).toBeUndefined();
    });

    it("uses Content-Type from response when mimeHint is absent", async () => {
      const textBytes = new Uint8Array(Buffer.from("plain text content"));
      vi.spyOn(client, "getAttachmentBytes").mockResolvedValue({ bytes: textBytes, contentType: "text/plain" });
      const { dispatch } = buildHarness(client);

      // No mimeHint param — handler should fall back to response Content-Type
      const res = await dispatch("GET", "/attachment", {}, {
        ref: "https://test.atlassian.net/attach/readme.txt",
      });

      expect(res.status).toBe(200);
      const body = res.body as { text?: string };
      expect(body.text).toBe("plain text content");
    });

    it("returns { images } for an image attachment", async () => {
      // Minimal 1×1 pixel PNG (8 bytes header + IHDR + IDAT + IEND)
      // Base64: a real 1x1 transparent PNG that sharp can parse
      const minimalPngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const pngBytes = new Uint8Array(Buffer.from(minimalPngBase64, "base64"));
      vi.spyOn(client, "getAttachmentBytes").mockResolvedValue({ bytes: pngBytes, contentType: "image/png" });
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/attachment", {}, {
        ref: "https://test.atlassian.net/attach/diagram.png",
        mimeHint: "image/png",
      });

      expect(res.status).toBe(200);
      const body = res.body as { text?: string; images?: Array<{ mime: string; dataBase64: string }> };
      expect(Array.isArray(body.images)).toBe(true);
      expect(body.images![0]?.mime).toMatch(/^image\//); // resized to PNG or kept as-is
      expect(typeof body.images![0]?.dataBase64).toBe("string");
      expect(body.text).toBeUndefined();
    });

    it("returns 400 when ref is missing", async () => {
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/attachment", {}, {});
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain("ref");
    });

    it("returns 400 when ref is not a valid URL", async () => {
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/attachment", {}, { ref: "not-a-url" });
      expect(res.status).toBe(400);
    });

    it("returns 4xx when client returns error for attachment download", async () => {
      vi.spyOn(client, "getAttachmentBytes").mockResolvedValue(atlassianError(403, "Forbidden"));
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/attachment", {}, {
        ref: "https://test.atlassian.net/attach/secret.pdf",
      });

      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toBe("Forbidden");
    });

    it("returns 413 when attachment exceeds size limit", async () => {
      vi.spyOn(client, "getAttachmentBytes").mockResolvedValue({ bytes: new Uint8Array(30 * 1024 * 1024), contentType: "application/octet-stream" });
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/attachment", {}, {
        ref: "https://test.atlassian.net/attach/huge.bin",
      });

      expect(res.status).toBe(413);
    });

    it("returns 403 when ref origin does not match baseUrl origin (credential exfiltration guard)", async () => {
      // The spy should NEVER be called — the host-gate fires before getAttachmentBytes.
      const spy = vi.spyOn(client, "getAttachmentBytes");
      const { dispatch } = buildHarness(client);

      const res = await dispatch("GET", "/attachment", {}, {
        ref: "https://evil.example.com/exfil/secret.bin",
      });

      expect(res.status).toBe(403);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/origin/);
      expect(spy).not.toHaveBeenCalled();
    });

    it("does not send Authorization header to off-origin URL (no fetch call at all)", async () => {
      // Confirm the guarded fetch stub is never reached for an off-origin ref.
      // If getAttachmentBytes were called it would hit the global fetch guard and throw.
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/attachment", {}, {
        ref: "https://attacker.io/steal",
      });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Token / credential leak assertions
  // -------------------------------------------------------------------------

  describe("credential safety", () => {
    const TOKEN = "test-token";
    const EMAIL = "user@example.com";

    it("error responses from /jira/:key never contain the token or email", async () => {
      vi.spyOn(client, "getIssue").mockResolvedValue(atlassianError(404, "Issue not found"));
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/jira/:key", { key: "PROJ-1" });
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain(TOKEN);
      expect(bodyStr).not.toContain(EMAIL);
    });

    it("error responses from /confluence/:id never contain the token or email", async () => {
      vi.spyOn(client, "getPage").mockResolvedValue(atlassianError(403, "Forbidden"));
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/confluence/:id", { id: "123" });
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain(TOKEN);
      expect(bodyStr).not.toContain(EMAIL);
    });

    it("error responses from /attachment (off-origin) never contain the token or email", async () => {
      const { dispatch } = buildHarness(client);
      const res = await dispatch("GET", "/attachment", {}, {
        ref: "https://evil.example.com/steal",
      });
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain(TOKEN);
      expect(bodyStr).not.toContain(EMAIL);
    });
  });

  // -------------------------------------------------------------------------
  // Isolation check — scan ALL src/ files for @tq/core
  // -------------------------------------------------------------------------

  it("no source file under src/ imports @tq/core", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { resolve, dirname, join } = await import("node:path");

    const dir = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(dir, "..");

    // Recursively collect all .ts files under src/ (excluding __tests__).
    function collectTs(d: string): string[] {
      const files: string[] = [];
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "__tests__") files.push(...collectTs(full));
        } else if (entry.endsWith(".ts") || entry.endsWith(".d.ts")) {
          files.push(full);
        }
      }
      return files;
    }

    const violations: string[] = [];
    for (const file of collectTs(srcDir)) {
      const content = readFileSync(file, "utf-8");
      if (content.includes("@tq/core")) {
        violations.push(file.replace(srcDir + "/", ""));
      }
    }
    expect(violations).toEqual([]);
  });
});
