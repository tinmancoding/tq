/**
 * client.test.ts — unit tests for AtlassianClient with mocked fetch.
 *
 * All tests mock the global `fetch` so no live network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AtlassianClient, isAtlassianError } from "../client.js";

const BASE_URL = "https://test.atlassian.net";
const EMAIL = "user@example.com";
const TOKEN = "test-api-token";
const EXPECTED_AUTH =
  "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");

function makeClient(timeoutMs = 15_000): AtlassianClient {
  return new AtlassianClient({ baseUrl: BASE_URL, email: EMAIL, token: TOKEN, timeoutMs });
}

function makeOkResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeErrorResponse(status: number, body?: unknown): Response {
  return new Response(body !== undefined ? JSON.stringify(body) : "", {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AtlassianClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Auth header
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("sends the correct Basic auth header", async () => {
      mockFetch.mockResolvedValueOnce(
        makeOkResponse({ id: "1", key: "PROJ-1", fields: { summary: "Test", status: { name: "Open" }, issuetype: { name: "Bug" }, labels: [] } }),
      );

      await makeClient().getIssue("PROJ-1");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(EXPECTED_AUTH);
    });

    it("credentials are never in the URL", async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ issues: [] }));
      await makeClient().searchJira("project = PROJ");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).not.toContain(TOKEN);
      expect(url).not.toContain(EMAIL);
    });
  });

  // -------------------------------------------------------------------------
  // Request shaping
  // -------------------------------------------------------------------------

  describe("request shaping", () => {
    it("getIssue includes expand=renderedFields by default", async () => {
      mockFetch.mockResolvedValueOnce(
        makeOkResponse({ id: "1", key: "PROJ-1", fields: { summary: "s", status: { name: "Open" }, issuetype: { name: "Bug" }, labels: [] } }),
      );

      await makeClient().getIssue("PROJ-1");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("expand=renderedFields");
    });

    it("getIssue accepts a custom expand value", async () => {
      mockFetch.mockResolvedValueOnce(
        makeOkResponse({ id: "1", key: "PROJ-1", fields: { summary: "s", status: { name: "Open" }, issuetype: { name: "Bug" }, labels: [] } }),
      );

      await makeClient().getIssue("PROJ-1", "renderedFields,changelog");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("renderedFields%2Cchangelog");
    });

    it("searchJira uses POST with JQL in body", async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ issues: [] }));

      await makeClient().searchJira("project = PROJ ORDER BY created", 5);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(url).toContain("/rest/api/3/search/jql");
      const body = JSON.parse(init.body as string) as { jql: string; maxResults: number };
      expect(body.jql).toBe("project = PROJ ORDER BY created");
      expect(body.maxResults).toBe(5);
    });

    it("getPage requests body-format=view", async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ id: "123", title: "My Page" }));

      await makeClient().getPage("123");

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/wiki/api/v2/pages/123");
      expect(url).toContain("body-format=view");
    });

    it("searchConfluence passes CQL and limit as query params", async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ results: [] }));

      await makeClient().searchConfluence('type = "page" AND text ~ "login"', 3);

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/wiki/rest/api/search");
      expect(url).toContain("limit=3");
    });
  });

  // -------------------------------------------------------------------------
  // Error normalisation
  // -------------------------------------------------------------------------

  describe("error normalisation", () => {
    it("returns { ok:false, status, message } on HTTP 404", async () => {
      mockFetch.mockResolvedValueOnce(
        makeErrorResponse(404, { errorMessages: ["Issue does not exist"] }),
      );

      const result = await makeClient().getIssue("PROJ-999");

      expect(isAtlassianError(result)).toBe(true);
      if (isAtlassianError(result)) {
        expect(result.ok).toBe(false);
        expect(result.status).toBe(404);
        expect(result.message).toContain("Issue does not exist");
      }
    });

    it("extracts message field from error body", async () => {
      mockFetch.mockResolvedValueOnce(
        makeErrorResponse(403, { message: "You do not have permission" }),
      );

      const result = await makeClient().getPage("42");
      expect(isAtlassianError(result)).toBe(true);
      if (isAtlassianError(result)) {
        expect(result.message).toBe("You do not have permission");
      }
    });

    it("returns { ok:false, status:0, message } on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await makeClient().getIssue("PROJ-1");

      expect(isAtlassianError(result)).toBe(true);
      if (isAtlassianError(result)) {
        expect(result.status).toBe(0);
        expect(result.message).toContain("ECONNREFUSED");
      }
    });

    it("returns { ok:false } on 401 unauthorized", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(401));

      const result = await makeClient().searchJira("project = X");
      expect(isAtlassianError(result)).toBe(true);
      if (isAtlassianError(result)) {
        expect(result.status).toBe(401);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe("timeout", () => {
    it("passes an AbortSignal to fetch (verifies timeout wiring)", async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ issues: [] }));

      await makeClient(5_000).searchJira("project = X");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeDefined();
      // AbortSignal.timeout creates a signal with a reason; just verify it's an AbortSignal
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("returns an error when the signal fires (AbortError)", async () => {
      const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      mockFetch.mockRejectedValueOnce(abortErr);

      const result = await makeClient(1).getIssue("PROJ-1");
      expect(isAtlassianError(result)).toBe(true);
      if (isAtlassianError(result)) {
        expect(result.status).toBe(0);
        expect(result.message).toContain("aborted");
      }
    });
  });

  // -------------------------------------------------------------------------
  // getAttachmentBytes
  // -------------------------------------------------------------------------

  describe("getAttachmentBytes", () => {
    it("downloads bytes and returns a Uint8Array", async () => {
      const fakeBytes = new Uint8Array([1, 2, 3, 4]);
      mockFetch.mockResolvedValueOnce(
        new Response(fakeBytes.buffer, { status: 200 }),
      );

      const result = await makeClient().getAttachmentBytes("https://test.atlassian.net/attach/1");

      expect(result).toHaveProperty("bytes");
      expect(result).toHaveProperty("contentType");
      const { bytes, contentType } = result as { bytes: Uint8Array; contentType: string };
      expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
      expect(typeof contentType).toBe("string");
    });

    it("sends auth header to the attachment URL", async () => {
      const fakeBytes = new Uint8Array([0]);
      mockFetch.mockResolvedValueOnce(new Response(fakeBytes.buffer, { status: 200 }));

      await makeClient().getAttachmentBytes("https://test.atlassian.net/attach/99");

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(EXPECTED_AUTH);
    });

    it("returns error on non-200 response", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 403, statusText: "Forbidden" }));

      const result = await makeClient().getAttachmentBytes("https://test.atlassian.net/attach/x");
      expect(isAtlassianError(result)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Confluence v2 secondary endpoints — URL + auth
  // -------------------------------------------------------------------------

  describe("getPageLabels", () => {
    it("hits the correct v2 labels URL with auth", async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ results: [] }));

      await makeClient().getPageLabels("123456");

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/wiki/api/v2/pages/123456/labels`);
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(EXPECTED_AUTH);
    });

    it("returns normalized error on 404", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(404, { message: "Page not found" }));
      const result = await makeClient().getPageLabels("999");
      expect(isAtlassianError(result)).toBe(true);
      if (isAtlassianError(result)) expect(result.status).toBe(404);
    });
  });

  describe("getPageFooterComments", () => {
    it("hits the correct v2 footer-comments URL with body-format=view and auth", async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ results: [] }));

      await makeClient().getPageFooterComments("123456");

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/wiki/api/v2/pages/123456/footer-comments?body-format=view`);
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(EXPECTED_AUTH);
    });

    it("returns normalized error on 403", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(403, { message: "Forbidden" }));
      const result = await makeClient().getPageFooterComments("42");
      expect(isAtlassianError(result)).toBe(true);
      if (isAtlassianError(result)) expect(result.status).toBe(403);
    });
  });

  describe("getPageAttachments", () => {
    it("hits the correct v2 attachments URL with auth", async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ results: [] }));

      await makeClient().getPageAttachments("123456");

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/wiki/api/v2/pages/123456/attachments`);
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(EXPECTED_AUTH);
    });

    it("returns normalized error on 500", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(500, { message: "Internal Server Error" }));
      const result = await makeClient().getPageAttachments("42");
      expect(isAtlassianError(result)).toBe(true);
      if (isAtlassianError(result)) expect(result.status).toBe(500);
    });
  });
});
