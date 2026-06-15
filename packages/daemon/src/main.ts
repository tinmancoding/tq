import { Store, loadConfig } from "@tq/core";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildServer } from "./server.js";
import {
  PiTriageEngine,
  prepareImageForTriage,
  triageExtension,
  type TriageImage,
} from "@tq/ext-triage";
import {
  HashEmbedder,
  TitanEmbedder,
  searchSemanticExtension,
  type Embedder,
} from "@tq/ext-search-semantic";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = Store.open({
    path: config.daemon.db_path,
    attachmentsDir: config.daemon.attachments_dir,
    contextSpillBytes: config.context.spill_bytes,
  });

  // Semantic search runs as an extension (@tq/ext-search-semantic) with its own
  // vector store. The embedder is pluggable: local HashEmbedder (default, no
  // AWS) or Titan via config. Core itself is FTS-only.
  const embedder: Embedder =
    config.embeddings.provider === "titan"
      ? new TitanEmbedder({
          region: config.aws.region,
          model: config.embeddings.model,
          dims: config.embeddings.dims,
        })
      : new HashEmbedder(config.embeddings.dims);
  const searchExt = searchSemanticExtension({
    embedder,
    dbPath: join(dirname(config.daemon.db_path), "ext-search-semantic.db"),
  });
  // eslint-disable-next-line no-console
  console.error(`[tq] semantic search extension enabled (embedder: ${config.embeddings.provider})`);

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
        searchExt,
      ]
    : [searchExt];
  // eslint-disable-next-line no-console
  console.error(
    engine.probe()
      ? `[tq] triage extension enabled (model ${config.triage.model})`
      : `[tq] triage disabled: model ${config.triage.provider}/${config.triage.model} not available (check AWS creds). Intake will queue.`,
  );

  const webDist = new URL("../../web/dist", import.meta.url).pathname;
  const app = buildServer({ store, config, logger: true, webDist, extensions });
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
