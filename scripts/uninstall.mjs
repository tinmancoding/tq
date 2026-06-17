#!/usr/bin/env node
// scripts/uninstall.mjs — remove the tq launchd agent and CLI shim.
// Data and config under the repo are NEVER deleted.
// Node built-ins only; no npm dependencies.
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const label = "tq.daemon";
const uid = process.getuid();
const guiTarget = `gui/${uid}/${label}`;
const HOME = homedir();
const plistPath = join(HOME, "Library", "LaunchAgents", "tq.daemon.plist");
const shimPath = join(HOME, ".local", "bin", "task");

// 1. Unload the launchd agent (ignore failure — may not be loaded)
try {
  execSync(`launchctl bootout ${guiTarget} 2>/dev/null || true`, { stdio: "inherit" });
  console.log("✓ launchd agent unloaded:", label);
} catch {
  console.log("· launchd agent was not loaded (or already removed)");
}

// 2. Remove the plist
if (existsSync(plistPath)) {
  rmSync(plistPath);
  console.log("✓ plist removed:", plistPath);
} else {
  console.log("· plist not found (already removed):", plistPath);
}

// 3. Remove the CLI shim
if (existsSync(shimPath)) {
  rmSync(shimPath);
  console.log("✓ task shim removed:", shimPath);
} else {
  console.log("· task shim not found (already removed):", shimPath);
}

// 4. Summary — data and config are intentionally preserved
console.log("");
console.log("Uninstall complete.");
console.log("Data and config under ~/.tq are preserved.");
console.log("Full wipe (irreversible): rm -rf ~/.tq ~/.local/bin/task");
