#!/usr/bin/env node
// scripts/restart.mjs — restart the tq daemon via launchd and health-check it.
// Node built-ins only; no npm dependencies.
import { execSync } from "node:child_process";

const label = "tq.daemon";
const uid = process.getuid();
const guiTarget = `gui/${uid}/${label}`;

console.log("Restarting", label, "…");

try {
  execSync(`launchctl kickstart -k ${guiTarget}`, { stdio: "inherit" });
  console.log("✓ daemon restarted");
} catch (e) {
  console.error("⚠  launchctl kickstart failed:", e.message);
  console.error("   Is the daemon loaded? Run `make install` first.");
  process.exit(1);
}

// Wait briefly for the daemon to bind
await new Promise((r) => setTimeout(r, 1200));

// Health check
try {
  const res = await fetch("http://127.0.0.1:7788/api/health");
  if (res.ok) {
    console.log("✓ daemon health OK (http://127.0.0.1:7788)");
  } else {
    console.log("❌ daemon returned HTTP", res.status);
  }
} catch {
  console.log("❌ daemon not reachable at http://127.0.0.1:7788/api/health");
}
