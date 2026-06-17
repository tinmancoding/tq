/**
 * atlassian-extension.test.ts — Phase C integration test
 *
 * Uses buildServer + app.inject through REAL Fastify routing to close the
 * Phase B harness gap. Verifies:
 *  - /api/ext/atlassian/* routes are mounted and respond correctly
 *  - /jira/search and /confluence/search are NOT shadowed by :key / :id params
 *  - Absent creds → connector not wired → 404 on all atlas routes
 *  - AtlassianClient is fully MOCKED — no live network.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockedObject } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, defaultConfig, type TqConfig } from "@tq/core";
import { AtlassianClient, atlassianExtension } from "@tq/ext-atlassian";
import { buildServer, type TqServer } from "../server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(): TqConfig {
  return {
    ...defaultConfig(),
    extensions: { atlassian: { enabled: true } },
  };
}

/** Build a fully mocked AtlassianClient (vi.fn() stubs on all public methods). */
function mockClient(): MockedObject<AtlassianClient> {
  return {
    getIssue: vi.fn(),
    searchJira: vi.fn(),
    getPage: vi.fn(),
    searchConfluence: vi.fn(),
    getPageLabels: vi.fn(),
    getPageFooterComments: vi.fn(),
    getPageAttachments: vi.fn(),
    getAttachmentBytes: vi.fn(),
  } as unknown as MockedObject<AtlassianClient>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_ISSUE = {
  id: "10001",
  key: "PROJ-1",
  fields: {
    summary: "Login broken",
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    labels: ["auth"],
    description: null,
  },
  renderedFields: { description: "<p>Login is broken</p>" },
};

const FAKE_SEARCH_RESULT = {
  issues: [
    {
      key: "PROJ-1",
      fields: {
        summary: "Login broken",
        status: { name: "In Progress" },
        issuetype: { name: "Bug" },
      },
    },
  ],
};

const FAKE_PAGE = {
  id: "123456",
  title: "Team Handbook",
  _links: { webui: "/wiki/spaces/TEAM/pages/123456" },
  body: { view: { value: "<p>Our handbook.</p>" } },
};

const FAKE_CONFLUENCE_SEARCH = {
  results: [
    {
      content: {
        id: "123456",
        title: "Team Handbook",
        type: "page",
        _links: { webui: "/wiki/spaces/TEAM/pages/123456" },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("atlassian extension — daemon-harness integration (Phase C)", () => {
  let store: Store;
  let server: TqServer;
  let client: MockedObject<AtlassianClient>;

  beforeEach(() => {
    store = Store.open({
      path: ":memory:",
      attachmentsDir: mkdtempSync(join(tmpdir(), "tq-atl-")),
    });
    client = mockClient();
    server = buildServer({
      store,
      config: cfg(),
      extensions: [atlassianExtension({ client: client as unknown as AtlassianClient })],
    });
    server.tqExtensionHost.start();
  });

  afterEach(async () => {
    server.tqExtensionHost.stop();
    await server.close();
    store.close();
  });

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  it("GET /api/ext/atlassian/health → 200 { ok: true }", async () => {
    const res = await server.inject({ method: "GET", url: "/api/ext/atlassian/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, connector: "atlassian" });
  });

  // -------------------------------------------------------------------------
  // Jira issue
  // -------------------------------------------------------------------------

  it("GET /api/ext/atlassian/jira/:key → 200 normalized issue", async () => {
    client.getIssue.mockResolvedValue(FAKE_ISSUE);

    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/jira/PROJ-1",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body["ref"]).toBe("PROJ-1");
    expect(body["title"]).toBe("Login broken");
    expect(client.getIssue).toHaveBeenCalledWith("PROJ-1", "renderedFields");
  });

  it("GET /api/ext/atlassian/jira/:key upstream 404 → 404 response", async () => {
    client.getIssue.mockResolvedValue({ ok: false, status: 404, message: "Issue does not exist" });

    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/jira/NOPE-999",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Issue does not exist" });
  });

  // -------------------------------------------------------------------------
  // Jira search — MUST NOT be shadowed by /jira/:key
  // -------------------------------------------------------------------------

  it("GET /api/ext/atlassian/jira/search → search handler (not shadowed by :key)", async () => {
    client.searchJira.mockResolvedValue(FAKE_SEARCH_RESULT);

    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/jira/search?jql=project%3DPROJ",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { hits: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.hits).toHaveLength(1);

    // The search handler was called — NOT getIssue (which would indicate :key shadowing)
    expect(client.searchJira).toHaveBeenCalledWith("project=PROJ", 10);
    expect(client.getIssue).not.toHaveBeenCalled();
  });

  it("GET /api/ext/atlassian/jira/search without jql → 400", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/jira/search",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "jql is required" });
    expect(client.searchJira).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Confluence page
  // -------------------------------------------------------------------------

  it("GET /api/ext/atlassian/confluence/:id → 200 normalized page", async () => {
    client.getPage.mockResolvedValue(FAKE_PAGE);

    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/confluence/123456",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body["ref"]).toBe("123456");
    expect(body["title"]).toBe("Team Handbook");
    expect(client.getPage).toHaveBeenCalledWith("123456");
  });

  it("GET /api/ext/atlassian/confluence/:id upstream 403 → 403 response", async () => {
    client.getPage.mockResolvedValue({ ok: false, status: 403, message: "Not permitted" });

    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/confluence/secret",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "Not permitted" });
  });

  // -------------------------------------------------------------------------
  // Confluence search — MUST NOT be shadowed by /confluence/:id
  // -------------------------------------------------------------------------

  it("GET /api/ext/atlassian/confluence/search → search handler (not shadowed by :id)", async () => {
    client.searchConfluence.mockResolvedValue(FAKE_CONFLUENCE_SEARCH);

    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/confluence/search?cql=text%3Dhandbook",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { hits: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.hits).toHaveLength(1);

    // The search handler was called — NOT getPage (which would indicate :id shadowing)
    expect(client.searchConfluence).toHaveBeenCalledWith("text=handbook", 10);
    expect(client.getPage).not.toHaveBeenCalled();
  });

  it("GET /api/ext/atlassian/confluence/search without cql → 400", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/confluence/search",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "cql is required" });
    expect(client.searchConfluence).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Attachment
  // -------------------------------------------------------------------------

  it("GET /api/ext/atlassian/attachment → processes bytes into {text}", async () => {
    const textBytes = new Uint8Array(Buffer.from("hello world"));
    client.getAttachmentBytes.mockResolvedValue({ bytes: textBytes, contentType: "text/plain" });

    const res = await server.inject({
      method: "GET",
      // Use mimeHint param (renamed from id)
      url: "/api/ext/atlassian/attachment?ref=https%3A%2F%2Fdiligentbrands.atlassian.net%2Frest%2Fapi%2F3%2Fattachment%2Fcontent%2F1234&mimeHint=text%2Fplain",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // text/plain attachment → {text: "hello world"}
    expect(typeof body["text"]).toBe("string");
    expect(client.getAttachmentBytes).toHaveBeenCalled();
  });

  it("GET /api/ext/atlassian/attachment without ref → 400", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/attachment",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "ref is required" });
  });

  it("GET /api/ext/atlassian/attachment with wrong origin → 403", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/ext/atlassian/attachment?ref=https%3A%2F%2Fevil.example.com%2Fattachment%2F1",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/not the configured Atlassian instance/);
    expect(client.getAttachmentBytes).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Absent-creds test: connector NOT wired → all routes 404
// ---------------------------------------------------------------------------

describe("atlassian connector absent (no creds wired)", () => {
  let store: Store;
  let server: TqServer;

  beforeEach(() => {
    store = Store.open({
      path: ":memory:",
      attachmentsDir: mkdtempSync(join(tmpdir(), "tq-atl-off-")),
    });
    // Build server with NO atlassian extension in the extensions array
    server = buildServer({
      store,
      config: defaultConfig(),
      extensions: [], // connector not added — simulates absent creds
    });
    server.tqExtensionHost.start();
  });

  afterEach(async () => {
    server.tqExtensionHost.stop();
    await server.close();
    store.close();
  });

  it("GET /api/ext/atlassian/health → 404 when connector not hosted", async () => {
    const res = await server.inject({ method: "GET", url: "/api/ext/atlassian/health" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/ext/atlassian/jira/PROJ-1 → 404 when connector not hosted", async () => {
    const res = await server.inject({ method: "GET", url: "/api/ext/atlassian/jira/PROJ-1" });
    expect(res.statusCode).toBe(404);
  });
});
