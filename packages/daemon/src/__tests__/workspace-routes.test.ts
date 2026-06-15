import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, defaultConfig } from "@tq/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { ProviderRegistry } from "../workspace/registry.js";
import { LocalProvider } from "../workspace/local-provider.js";
import { WorkspaceService } from "../workspace/service.js";

let store: Store;
let app: FastifyInstance;
let base: string;
let svc: WorkspaceService;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "tq-wsroutes-"));
  store = Store.open({ path: ":memory:" });
  const providers = new ProviderRegistry([new LocalProvider(base)]);
  svc = new WorkspaceService(store, providers);
  app = buildServer({
    store,
    config: defaultConfig(),
    logger: false,
    workspaces: svc,
    providers,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
  rmSync(base, { recursive: true, force: true });
});

async function newTask(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "T" } });
  return res.json().id;
}

describe("workspace routes", () => {
  it("creates a workspace (202 provisioning) then resolves to ready", async () => {
    const id = await newTask();
    const create = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/workspace`,
      payload: { provider: "local", name: "wsx" },
    });
    expect(create.statusCode).toBe(202);
    expect(create.json().status).toBe("provisioning");

    await svc.whenSettled(create.json().id);
    const get = await app.inject({ method: "GET", url: `/api/tasks/${id}/workspace` });
    expect(get.statusCode).toBe(200);
    expect(get.json().status).toBe("ready");
  });

  it("409s on a second workspace for the same task", async () => {
    const id = await newTask();
    await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/workspace`,
      payload: { provider: "local" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/workspace`,
      payload: { provider: "local" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("detaches a workspace without deleting disk", async () => {
    const id = await newTask();
    const create = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/workspace`,
      payload: { provider: "local" },
    });
    await svc.whenSettled(create.json().id);
    const del = await app.inject({ method: "DELETE", url: `/api/tasks/${id}/workspace` });
    expect(del.statusCode).toBe(204);
    const get = await app.inject({ method: "GET", url: `/api/tasks/${id}/workspace` });
    expect(get.statusCode).toBe(404);
  });

  it("lists sessions (empty) and 404s unknown session", async () => {
    const id = await newTask();
    const create = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/workspace`,
      payload: { provider: "local" },
    });
    await svc.whenSettled(create.json().id);
    const sessions = await app.inject({ method: "GET", url: `/api/tasks/${id}/sessions` });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().sessions).toEqual([]);

    const bad = await app.inject({ method: "GET", url: "/api/sessions/nope" });
    expect(bad.statusCode).toBe(404);
  });

  it("scan endpoint rebuilds the cache", async () => {
    const scan = await app.inject({ method: "POST", url: "/api/workspaces/scan" });
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toHaveProperty("upserted");
  });

  it("start returns the print-command fallback when launcher unset", async () => {
    const id = await newTask();
    const create = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/workspace`,
      payload: { provider: "local" },
    });
    await svc.whenSettled(create.json().id);
    const start = await app.inject({ method: "POST", url: `/api/tasks/${id}/sessions/start` });
    expect(start.statusCode).toBe(200);
    expect(start.json().launched).toBe(false);
    expect(start.json().command).toContain("pi");
  });
});
