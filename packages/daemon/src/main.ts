import { Store, loadConfig, EmbeddingWorker, isVecAvailable } from "@tq/core";
import { existsSync } from "node:fs";
import { buildServer } from "./server.js";
import {
  PiTriageEngine,
  prepareImageForTriage,
  triageExtension,
  type TriageImage,
} from "@tq/ext-triage";
import { TitanEmbedder } from "./embeddings/titan.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = Store.open({
    path: config.daemon.db_path,
    embeddingDims: config.embeddings.dims,
    attachmentsDir: config.daemon.attachments_dir,
    contextSpillBytes: config.context.spill_bytes,
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

  // Triage runs as an event-driven extension (@tq/ext-triage). It's enabled in
  // config and hosted only when the Bedrock model is reachable; otherwise
  // intake is captured and waits (retriage re-runs once creds are present).
  const engine = new PiTriageEngine({
    provider: config.triage.provider,
    model: config.triage.model,
    labelVocabulary: config.triage.label_vocabulary,
  });
  const loadImages = (intakeId: string): Promise<TriageImage[]> =>
    Promise.all(
      store.attachments
        .forIntake(intakeId)
        .filter((a) => a.mime.startsWith("image/"))
        .map((a) => prepareImageForTriage(store.attachments.filePath(a.sha256), a.mime)),
    ).then((imgs) => imgs.filter((img): img is NonNullable<typeof img> => !!img && img.dataBase64.length > 0));

  const extensions = engine.probe()
    ? [
        triageExtension({
          engine,
          autoCreateConfidence: config.triage.auto_create_confidence,
          loadImages,
        }),
      ]
    : [];
  // eslint-disable-next-line no-console
  console.error(
    engine.probe()
      ? `[tq] triage extension enabled (model ${config.triage.model})`
      : `[tq] triage disabled: model ${config.triage.provider}/${config.triage.model} not available (check AWS creds). Intake will queue.`,
  );

  const webDist = new URL("../../web/dist", import.meta.url).pathname;
  const app = buildServer({ store, config, logger: true, embedder, webDist, extensions });
  // eslint-disable-next-line no-console
  console.error(
    existsSync(webDist)
      ? `[tq] serving web dashboard at http://${config.daemon.host}:${config.daemon.port}/`
      : `[tq] web dashboard not built (run: pnpm --filter @tq/web build) — API only`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.error(`[tq] received ${signal}, shutting down`);
    app.tqExtensionHost.stop();
    embeddingWorker?.stop();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.daemon.host, port: config.daemon.port });
  app.tqExtensionHost.start();
  // eslint-disable-next-line no-console
  console.error(`[tq] daemon listening on http://${config.daemon.host}:${config.daemon.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[tq] fatal:", err);
  process.exit(1);
});
