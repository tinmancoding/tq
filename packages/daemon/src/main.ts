import { Store, loadConfig, TriageWorkerPool } from "@tq/core";
import { buildServer } from "./server.js";
import { PiTriageEngine } from "./triage/pi-engine.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = Store.open({ path: config.daemon.db_path });

  // Crash recovery: requeue any jobs left mid-flight by a previous run.
  const recovered = store.jobs.recoverRunning();
  if (recovered > 0) {
    // eslint-disable-next-line no-console
    console.error(`[tq] recovered ${recovered} stuck triage job(s)`);
  }

  // Triage worker pool — started only when the Bedrock model is reachable.
  const engine = new PiTriageEngine(config);
  let pool: TriageWorkerPool | null = null;
  if (engine.probe()) {
    pool = new TriageWorkerPool(store, engine, {
      concurrency: config.triage.concurrency,
      maxAttempts: config.triage.max_attempts,
      autoCreateConfidence: config.triage.auto_create_confidence,
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

  const app = buildServer({ store, config, logger: true });

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.error(`[tq] received ${signal}, shutting down`);
    pool?.stop();
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
