import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, defaultConfig, type TqConfig } from "@tq/core";
import { searchSemanticExtension, HashEmbedder } from "@tq/ext-search-semantic";
import { buildServer, type TqServer } from "../server.js";

function injectFetch(getApp: () => TqServer): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const res = await getApp().inject({
      method: (init?.method ?? "GET") as never,
      url: u.pathname + u.search,
      headers: (init?.headers as Record<string, string>) ?? {},
      payload: init?.body as string | undefined,
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: { "content-type": res.headers["content-type"]?.toString() ?? "application/json" },
    });
  }) as typeof fetch;
}

function cfg(): TqConfig {
  return { ...defaultConfig(), extensions: { "search-semantic": { enabled: true } } };
}

async function semanticSearch(server: TqServer, q: string) {
  const res = await server.inject({
    method: "GET",
    url: `/api/ext/search-semantic/search?q=${encodeURIComponent(q)}`,
  });
  return res.json() as {
    hits: { task: { id: string; title: string }; signals: { fts: boolean; vector: boolean } }[];
    vector: boolean;
  };
}

describe("@tq/ext-search-semantic (Phase H)", () => {
  let store: Store;
  let server: TqServer;

  beforeEach(() => {
    store = Store.open({ path: ":memory:", attachmentsDir: mkdtempSync(join(tmpdir(), "tq-ss-")) });
  });
  afterEach(async () => {
    server.tqExtensionHost.stop();
    await server.close();
    store.close();
  });

  function bootWith(embedder: { dims: number; embed: (t: string) => Promise<number[]> }): void {
    server = buildServer({
      store,
      config: cfg(),
      extensions: [searchSemanticExtension({ embedder, dbPath: ":memory:" })],
      coreFetch: injectFetch(() => server),
    });
    server.tqExtensionHost.start();
  }

  it("rebuilds its vector index by replaying TaskCreated from seq 0, then fuses with FTS", async () => {
    // Tasks created BEFORE the host starts → must be replayed and embedded.
    const a = store.tasks.create({ title: "Fix login auth cookie bug", body: "session expiry" });
    store.tasks.create({ title: "Write onboarding docs", body: "getting started guide" });

    bootWith(new HashEmbedder(64));
    await server.tqExtensionHost.idle();

    const res = await semanticSearch(server, "auth cookie login");
    expect(res.vector).toBe(true); // vector signal contributed
    expect(res.hits[0]!.task.id).toBe(a.id);

    const disc = (await server.inject({ method: "GET", url: "/api/extensions" })).json();
    const ext = disc.extensions.find((e: { name: string }) => e.name === "search-semantic");
    expect(ext.events.lag).toBe(0);
    expect(ext.events.dead_letters).toBe(0);
  });

  it("indexes live tasks and reflects them in hybrid results", async () => {
    bootWith(new HashEmbedder(64));
    const t = (
      await server.inject({ method: "POST", url: "/api/tasks", payload: { title: "rate limit the search API" } })
    ).json();
    await server.tqExtensionHost.idle();

    const res = await semanticSearch(server, "rate limit");
    expect(res.hits.some((h) => h.task.id === t.id)).toBe(true);
  });

  it("degrades to FTS-only when the embedder always fails", async () => {
    bootWith({ dims: 64, embed: () => Promise.reject(new Error("embedder down")) });

    await server.inject({ method: "POST", url: "/api/tasks", payload: { title: "cookie expiry investigation" } });
    await server.tqExtensionHost.idle();

    const res = await semanticSearch(server, "cookie");
    expect(res.vector).toBe(false); // no vector signal
    expect(res.hits.length).toBe(1); // FTS still works
    expect(res.hits[0]!.signals).toEqual({ fts: true, vector: false });
  });
});
