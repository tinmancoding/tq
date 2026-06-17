import { Store, configDir, loadConfig } from "@tq/core";
import { existsSync, readFileSync } from "node:fs";
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
import { AtlassianClient, atlassianExtension } from "@tq/ext-atlassian";

async function main(): Promise<void> {
  // Load secrets from <configDir>/tq.env before config is read so creds are
  // available for triage / atlassian connectors. launchd agents don't inherit
  // the interactive shell env, so this is the primary secrets delivery path.
  // Real process.env values always win over the file (don't overwrite existing).
  const envFile = join(configDir(), "tq.env");
  if (existsSync(envFile)) {
    const lines = readFileSync(envFile, "utf8").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      // Skip blank lines and comments
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // Strip optional surrounding single or double quotes
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Real env wins — only set if not already defined
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  }

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
    thinkingLevel: config.triage.thinking_level,
    toolCallBudget: config.triage.tool_call_budget,
    passTimeoutMs: config.atlassian.pass_timeout_ms,
    jiraProjects: config.atlassian.jira_projects,
    prefetchMax: config.atlassian.prefetch_max,
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
          passTimeoutMs: config.atlassian.pass_timeout_ms,
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

  // Atlassian connector registers only when both env creds are present (token-gate, design §4).
  const atlassianEmail = process.env["ATLASSIAN_EMAIL"];
  const atlassianToken = process.env["ATLASSIAN_API_TOKEN"];
  if (atlassianEmail && atlassianToken) {
    const atlassianClient = new AtlassianClient({
      baseUrl: config.atlassian.base_url,
      email: atlassianEmail,
      token: atlassianToken,
      timeoutMs: config.atlassian.request_timeout_ms,
    });
    const atlassianExt = atlassianExtension({
      client: atlassianClient,
      config: {
        baseUrl: config.atlassian.base_url,
        bodyMarkdownMaxChars: config.atlassian.body_markdown_max_chars,
        attachmentMaxBytes: config.atlassian.attachment_max_bytes,
      },
    });
    extensions.push(atlassianExt);
    // eslint-disable-next-line no-console
    console.error(`[tq] atlassian connector enabled (base_url: ${config.atlassian.base_url})`);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[tq] atlassian connector disabled (no creds)`);
  }

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
