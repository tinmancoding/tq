#!/usr/bin/env node
// Run the daemon (tsx) and the Vite dev server together for local web dev.
// Design §17: `pnpm dev` runs daemon + web. Kept as a tiny supervisor so we
// don't add a concurrently dependency.
import { spawn } from "node:child_process";

const procs = [
  { name: "daemon", cmd: "pnpm", args: ["dev"] },
  { name: "web", cmd: "pnpm", args: ["dev:web"] },
];

const children = procs.map(({ name, cmd, args }) => {
  const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    console.log(`[dev:all] ${name} exited (${code}) — shutting down`);
    shutdown();
  });
  return child;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
