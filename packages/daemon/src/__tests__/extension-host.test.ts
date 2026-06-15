import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, defaultConfig, type TqConfig } from "@tq/core";
import { defineExtension } from "@tq/extension-sdk";
import { buildServer, type TqServer } from "../server.js";

/** Adapt the contract CoreClient's fetch to in-process app.inject (no sockets). */
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

function cfgWith(extensions: TqConfig["extensions"]): TqConfig {
  return { ...defaultConfig(), extensions };
}

describe("extension host (Phase F)", () => {
  let store: Store;
  let server: TqServer;

  beforeEach(() => {
    store = Store.open({
      path: ":memory:",
      attachmentsDir: mkdtempSync(join(tmpdir(), "tq-ext-")),
    });
  });
  afterEach(async () => {
    server.tqExtensionHost.stop();
    await server.close();
    store.close();
  });

  it("replays backlog + live-tails, round-trips through the CoreClient, and serves gateway routes", async () => {
    const seen: string[] = [];

    const greeter = defineExtension({
      name: "greeter",
      setup: (ctx) => {
        ctx.on({ types: ["TaskCreated"] }, async (ev) => {
          seen.push(ev.scope_id!);
          // Enrich via the PUBLIC api (not @tq/core) — proves the injected client.
          await ctx.core.context.set("tasks", ev.scope_id!, "greeter", { greeted: true });
        });
        ctx.route({
          method: "GET",
          path: "/stats",
          handler: () => ({ body: { greeted: seen.length } }),
        });
      },
    });

    // One task exists BEFORE the host starts → must be replayed from cursor 0.
    const pre = store.tasks.create({ title: "backlog" });

    server = buildServer({
      store,
      config: cfgWith({ greeter: { enabled: true } }),
      extensions: [greeter],
      coreFetch: injectFetch(() => server),
    });
    server.tqExtensionHost.start();
    await server.tqExtensionHost.idle();

    // Backlog event delivered + context written back through the API.
    expect(seen).toContain(pre.id);
    expect(store.context.get("task", pre.id)).toEqual({ greeter: { greeted: true } });

    // Live event: create via the API, then let the host drain.
    const live = await server.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "live one" },
    });
    const liveId = live.json().id as string;
    await server.tqExtensionHost.idle();
    expect(seen).toContain(liveId);

    // Gateway route is mounted under the extension prefix.
    const stats = await server.inject({ method: "GET", url: "/api/ext/greeter/stats" });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toEqual({ greeted: 2 });

    // Discovery reflects the consumer cursor advancing to the head.
    const disc = await server.inject({ method: "GET", url: "/api/extensions" });
    const ext = disc.json().extensions.find((e: { name: string }) => e.name === "greeter");
    expect(ext.routes).toContainEqual({ method: "GET", path: "/api/ext/greeter/stats" });
    expect(ext.events.cursor).toBe(store.events.maxSeq());
    expect(ext.events.lag).toBe(0);
    expect(ext.events.dead_letters).toBe(0);
  });

  it("disabled extensions are not hosted", async () => {
    const ext = defineExtension({ name: "off", setup: (ctx) => ctx.onAny(() => {}) });
    server = buildServer({ store, config: cfgWith({ off: { enabled: false } }), extensions: [ext] });
    expect(server.tqExtensionHost.names()).toEqual([]);
    const disc = await server.inject({ method: "GET", url: "/api/extensions" });
    expect(disc.json().extensions).toEqual([]);
  });

  it("dead-letters a persistently failing handler and advances past the poison", async () => {
    const boom = defineExtension({
      name: "boom",
      setup: (ctx) => {
        ctx.on({ types: ["TaskCreated"] }, () => {
          throw new Error("always fails");
        });
      },
    });
    server = buildServer({
      store,
      config: cfgWith({ boom: { enabled: true } }),
      extensions: [boom],
      coreFetch: injectFetch(() => server),
    });
    server.tqExtensionHost.start();

    await server.inject({ method: "POST", url: "/api/tasks", payload: { title: "poison" } });
    await server.tqExtensionHost.idle();

    const sub = store.subscriptions.get("boom")!;
    expect(sub.dead_letters.length).toBe(1);
    expect(sub.dead_letters[0]!.error).toBe("always fails");
    // cursor still advanced to head despite the poison
    expect(sub.cursor).toBe(store.events.maxSeq());
  });
});
