import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { daemonBaseUrl, loadConfig } from "@tq/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const daemonMain = join(repoRoot, "packages/daemon/src/main.ts");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");

function runtimeDir(): string {
  const dir = join(homedir(), ".local", "share", "tq");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function pidFile(): string {
  return join(runtimeDir(), "daemon.pid");
}
function logFile(): string {
  return join(runtimeDir(), "daemon.log");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  const f = pidFile();
  if (!existsSync(f)) return null;
  const pid = Number(readFileSync(f, "utf8").trim());
  return Number.isFinite(pid) && isAlive(pid) ? pid : null;
}

export async function daemonStart(): Promise<void> {
  const existing = readPid();
  if (existing) {
    process.stdout.write(`daemon already running (pid ${existing})\n`);
    return;
  }
  const log = logFile();
  const out = openSync(log, "a");
  const child = spawn(tsxBin, [daemonMain], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  if (child.pid) writeFileSync(pidFile(), String(child.pid));
  // Give it a moment to bind, then verify via health.
  await new Promise((r) => setTimeout(r, 800));
  process.stdout.write(`daemon started (pid ${child.pid}); logs: ${log}\n`);
}

export async function daemonStop(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    process.stdout.write("daemon not running\n");
    return;
  }
  process.kill(pid, "SIGTERM");
  process.stdout.write(`daemon stopped (pid ${pid})\n`);
}

export async function daemonStatus(): Promise<void> {
  const cfg = loadConfig();
  const base = daemonBaseUrl(cfg);
  try {
    const res = await fetch(`${base}/api/health`);
    const health = await res.json();
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  } catch {
    process.stdout.write(`daemon unreachable at ${base}\n`);
    process.exitCode = 5;
  }
}

export function daemonLogs(): void {
  const f = logFile();
  if (!existsSync(f)) {
    process.stdout.write("(no logs yet)\n");
    return;
  }
  const tail = spawn("tail", ["-n", "100", "-f", f], { stdio: "inherit" });
  process.on("SIGINT", () => tail.kill());
}
