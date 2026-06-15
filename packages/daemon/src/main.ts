import { Store, loadConfig, TriageWorkerPool, EmbeddingWorker, isVecAvailable } from "@tq/core";
import { existsSync } from "node:fs";
import { buildServer } from "./server.js";
import { PiTriageEngine } from "./triage/pi-engine.js";
import { prepareImageForTriage } from "./triage/resize-image.js";
import { TitanEmbedder } from "./embeddings/titan.js";
import { LocalProvider } from "./workspace/local-provider.js";
import { TasktreeProvider } from "./workspace/tasktree-provider.js";
import { ProviderRegistry } from "./workspace/registry.js";
import { WorkspaceService } from "./workspace/service.js";
import { scanForWorkspace } from "./sessions/scanner.js";
import { join } from "node:path";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = Store.open({
    path: config.daemon.db_path,
    embeddingDims: config.embeddings.dims,
    attachmentsDir: config.daemon.attachments_dir,
  });

  // Crash recovery: requeue any jobs left mid-flight by a previous run.
  const recovered = store.jobs.recoverRunning();
  if (recovered > 0) {
    // eslint-disable-next-line no-console
    console.error(`[tq] recovered ${recovered} stuck triage job(s)`);
  }

  // Embeddings + vector backfill (only meaningful when sqlite-vec loaded).
  const embedder = new TitanEmbedder(config);
  let embeddingWorker: EmbeddingWorker | null = null;
  if (isVecAvailable(store.db)) {
    embeddingWorker = new EmbeddingWorker(store, embedder);
    embeddingWorker.start();
    // eslint-disable-next-line no-console
    console.error(`[tq] vector search enabled (Titan ${config.embeddings.model}, ${config.embeddings.dims}d)`);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[tq] sqlite-vec unavailable → FTS-only search`);
  }

  // Triage worker pool — started only when the Bedrock model is reachable.
  const engine = new PiTriageEngine(config);
  let pool: TriageWorkerPool | null = null;
  if (engine.probe()) {
    pool = new TriageWorkerPool(store, engine, {
      concurrency: config.triage.concurrency,
      maxAttempts: config.triage.max_attempts,
      autoCreateConfidence: config.triage.auto_create_confidence,
      embedder,
      loadImages: (intakeId) =>
        Promise.all(
          store.attachments
            .forIntake(intakeId)
            .filter((a) => a.mime.startsWith("image/"))
            .map((a) => prepareImageForTriage(store.attachments.filePath(a.sha256), a.mime)),
        ).then((imgs) => imgs.filter((img): img is NonNullable<typeof img> => !!img && img.dataBase64.length > 0)),
    });
    pool.start();
    // eslint-disable-next-line no-console
    console.error(`[tq] triage pool started (concurrency ${config.triage.concurrency}, model ${config.triage.model})`);
  } else {
    // eslint-disable-next-line no-console
    console.error(
      `[tq] triage disabled: model ${config.triage.provider}/${config.triage.model} not available (check AWS creds). Intake will queue.`,
    );
  }

  // ── Workspaces + session collection ──
  const providers = new ProviderRegistry();
  const tasktree = new TasktreeProvider();
  if (tasktree.probe()) {
    providers.register(tasktree);
    // eslint-disable-next-line no-console
    console.error(`[tq] workspace provider: tasktree enabled`);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[tq] tasktree binary not found → local provider only`);
  }
  providers.register(new LocalProvider(join(config.daemon.attachments_dir, "..", "workspaces")));
  const workspaces = new WorkspaceService(store, providers);
  const recoveredWs = await workspaces.recoverProvisioning();
  if (recoveredWs > 0) {
    // eslint-disable-next-line no-console
    console.error(`[tq] recovered ${recoveredWs} interrupted workspace provision(s)`);
  }

  // Periodic session scan over ready workspaces (no live watcher in MVP).
  const scanTick = setInterval(() => {
    void (async () => {
      for (const ws of store.workspaces.list({ status: "ready" })) {
        try {
          await scanForWorkspace(store, providers, config, ws);
        } catch {
          /* best-effort */
        }
      }
    })();
  }, 60_000);
  scanTick.unref?.();

  // Mirror task labels → workspace annotations on task changes (debounced).
  const mirrorTimers = new Map<string, NodeJS.Timeout>();
  store.bus.subscribe(({ event, data }) => {
    if (event !== "task.updated" && event !== "task.moved") return;
    const taskId = (data as { id?: string })?.id;
    if (!taskId) return;
    clearTimeout(mirrorTimers.get(taskId));
    mirrorTimers.set(
      taskId,
      setTimeout(() => {
        mirrorTimers.delete(taskId);
        void workspaces.mirrorLabels(taskId);
      }, 2000),
    );
  });

  const webDist = new URL("../../web/dist", import.meta.url).pathname;
  const app = buildServer({ store, config, logger: true, embedder, webDist, workspaces, providers });
  // eslint-disable-next-line no-console
  console.error(
    existsSync(webDist)
      ? `[tq] serving web dashboard at http://${config.daemon.host}:${config.daemon.port}/`
      : `[tq] web dashboard not built (run: pnpm --filter @tq/web build) — API only`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.error(`[tq] received ${signal}, shutting down`);
    pool?.stop();
    embeddingWorker?.stop();
    clearInterval(scanTick);
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.daemon.host, port: config.daemon.port });
  // eslint-disable-next-line no-console
  console.error(`[tq] daemon listening on http://${config.daemon.host}:${config.daemon.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[tq] fatal:", err);
  process.exit(1);
});
