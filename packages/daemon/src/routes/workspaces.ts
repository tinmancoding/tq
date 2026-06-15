import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Store, TqConfig } from "@tq/core";
import { WorkspaceConflictError, WORKSPACE_PROVIDERS } from "@tq/core";
import { resolveActor } from "../context.js";
import type { WorkspaceService } from "../workspace/service.js";
import type { ProviderRegistry } from "../workspace/registry.js";
import { scanForWorkspace } from "../sessions/scanner.js";
import { parseTranscript } from "../sessions/transcript.js";
import { launchSession } from "../sessions/launcher.js";

const ProviderEnum = Type.Union(WORKSPACE_PROVIDERS.map((p) => Type.Literal(p)));

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  store: Store,
  svc: WorkspaceService,
  registry: ProviderRegistry,
  cfg: TqConfig,
): void {
  // ── Workspace lifecycle ──
  app.post(
    "/api/tasks/:id/workspace",
    {
      schema: {
        body: Type.Object({
          provider: Type.Optional(ProviderEnum),
          name: Type.Optional(Type.String()),
          template: Type.Optional(Type.String()),
          vars: Type.Optional(Type.Record(Type.String(), Type.String())),
        }),
      },
    },
    (req, reply) => {
      const id = store.tasks.resolveId((req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "task not found" });
      const b = req.body as {
        provider?: string;
        name?: string;
        template?: string;
        vars?: Record<string, string>;
      };
      const template = b.template ?? (cfg.session.default_template || undefined);
      try {
        const ws = svc.createForTask(id, {
          provider: b.provider,
          name: b.name,
          template,
          vars: b.vars,
        });
        return reply.code(202).send(ws);
      } catch (err) {
        if (err instanceof WorkspaceConflictError) {
          return reply.code(409).send({ error: "conflict", detail: err.message });
        }
        return reply.code(400).send({ error: "create_failed", detail: msg(err) });
      }
    },
  );

  app.post(
    "/api/tasks/:id/workspace/attach",
    {
      schema: {
        body: Type.Object({
          path: Type.String({ minLength: 1 }),
          provider: Type.Optional(ProviderEnum),
        }),
      },
    },
    async (req, reply) => {
      const id = store.tasks.resolveId((req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "task not found" });
      const b = req.body as { path: string; provider?: string };
      try {
        const ws = await svc.attachExisting(id, b.path, b.provider);
        return reply.code(201).send(ws);
      } catch (err) {
        if (err instanceof WorkspaceConflictError) {
          return reply.code(409).send({ error: "conflict", detail: err.message });
        }
        return reply.code(400).send({ error: "attach_failed", detail: msg(err) });
      }
    },
  );

  app.get("/api/tasks/:id/workspace", async (req, reply) => {
    const id = store.tasks.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "task not found" });
    const ws = store.workspaces.getByTask(id);
    if (!ws) return reply.code(404).send({ error: "no workspace" });
    return ws;
  });

  app.delete("/api/tasks/:id/workspace", (req, reply) => {
    const id = store.tasks.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "task not found" });
    const ws = svc.detach(id);
    if (!ws) return reply.code(404).send({ error: "no workspace" });
    return reply.code(204).send();
  });

  app.post("/api/workspaces/scan", async () => {
    const res = await svc.reconcile();
    return res;
  });

  // ── Sessions ──
  app.get("/api/tasks/:id/sessions", async (req, reply) => {
    const id = store.tasks.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "task not found" });
    const ws = store.workspaces.getByTask(id);
    if (ws) await scanForWorkspace(store, registry, cfg, ws);
    return { sessions: store.sessions.listForTask(id) };
  });

  app.get("/api/sessions/:id", (req, reply) => {
    const id = store.sessions.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "session not found" });
    return store.sessions.get(id)!;
  });

  app.get("/api/sessions/:id/transcript", (req, reply) => {
    const id = store.sessions.resolveId((req.params as { id: string }).id);
    if (!id) return reply.code(404).send({ error: "session not found" });
    const s = store.sessions.get(id)!;
    return { transcript: parseTranscript(s.session_file), file_present: s.file_present };
  });

  app.post(
    "/api/tasks/:id/sessions/start",
    (req, reply) => {
      const id = store.tasks.resolveId((req.params as { id: string }).id);
      if (!id) return reply.code(404).send({ error: "task not found" });
      const ws = store.workspaces.getByTask(id);
      if (!ws || ws.status !== "ready" || !ws.root_path) {
        return reply.code(409).send({ error: "no ready workspace" });
      }
      const b = (req.body ?? {}) as { session_file?: string };
      const corrId = Math.random().toString(36).slice(2, 10);
      const actor = `agent:pi:${corrId}`;
      const result = launchSession(cfg.session.launcher, {
        cwd: ws.root_path,
        cmd: cfg.session.default_cmd,
        actor,
        sessionFile: b.session_file,
      });
      return result;
    },
  );
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
