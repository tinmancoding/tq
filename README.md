# tq — triage queue

A personal, local-first system to capture anything, let an AI triage/enrich/dedup
it, and manage the resulting tasks through a small workflow — from a CLI, a web
dashboard, and pi agents. See [`intake-triage-design.md`](./intake-triage-design.md)
for the full design.

> **Status:** Phase 0 (skeleton) + Phase 1 (core CRUD, no AI) implemented.
> Triage (Phase 2), web (Phase 3), watchlists (Phase 4) are next.

## Layout

```
packages/
  core/     domain model: SQLite, repos, search (FTS), config, event bus
  daemon/   Fastify REST API + SSE, binds 127.0.0.1
  cli/      `task` binary — talks to the daemon over REST
```

## Quick start

```bash
pnpm install           # builds the better-sqlite3 native addon
cp config.example.toml ~/.config/tq/config.toml   # optional; sane defaults otherwise

# run the daemon (foreground)
pnpm dev
# …or background it
pnpm --filter @tq/cli start daemon start
```

Then drive it with the CLI (run via tsx during development):

```bash
alias task="pnpm --filter @tq/cli start --"

task add "Fix auth cookie bug" --label project:aibm --priority high
task ls
task move <id> doing
task log <id> "pushed changes, CI green"
task search "auth cookie"

task intake add --text "Review PR 123 for the auth fix"
task intake ls
task intake promote <id> --title "Review PR 123"
```

## What works now (Phase 1)

- **Tasks**: create, list (+ board grouping), show, edit, move (with system
  worklog), labels, refs, worklog/comment activity, soft/hard delete.
- **Intake**: capture, list, show, promote → task, link to existing task,
  discard (reason), retriage. Triage jobs are enqueued but not yet processed.
- **Search**: FTS5 keyword search (hybrid-ready; vector signal arrives Phase 2).
- **Daemon**: Fastify REST API, SSE event stream, health, crash recovery
  (requeues stuck jobs), pidfile-based start/stop + launchd install script.
- **Attribution**: `X-TQ-Actor` / `X-TQ-Token`; localhost is the boundary.

## Develop

```bash
pnpm test          # vitest: core repos/search + daemon route inject tests
pnpm typecheck     # tsc --noEmit across packages
```

## Deploy as a launchd agent

```bash
./scripts/install-launchd.sh   # writes ~/Library/LaunchAgents/dev.tq.daemon.plist
```
