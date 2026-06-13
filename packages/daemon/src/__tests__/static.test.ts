import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, defaultConfig } from "@tq/core";
import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";

let store: Store;
let app: FastifyInstance;
let dist: string;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
  dist = mkdtempSync(join(tmpdir(), "tq-web-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root>tq</div>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log('tq')");
});

afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dist, { recursive: true, force: true });
});

describe("static web serving", () => {
  it("serves index.html at /", async () => {
    app = buildServer({ store, config: defaultConfig(), logger: false, webDist: dist });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("id=root");
  });

  it("serves built assets", async () => {
    app = buildServer({ store, config: defaultConfig(), logger: false, webDist: dist });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log");
  });

  it("falls back to index.html for unknown non-API GET (deep links)", async () => {
    app = buildServer({ store, config: defaultConfig(), logger: false, webDist: dist });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/some/deep/link" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("id=root");
  });

  it("still 404s unknown API routes (no SPA fallback for /api)", async () => {
    app = buildServer({ store, config: defaultConfig(), logger: false, webDist: dist });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not found");
  });

  it("API still works alongside static", async () => {
    app = buildServer({ store, config: defaultConfig(), logger: false, webDist: dist });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("is a no-op when dist is absent (API-only dev)", async () => {
    app = buildServer({ store, config: defaultConfig(), logger: false, webDist: join(dist, "nonexistent") });
    await app.ready();
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
  });
});
