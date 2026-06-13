# tq — triage queue

A personal, local-first system to capture anything, let an AI triage/enrich/dedup
it, and manage the resulting tasks through a small workflow — from a CLI, a web
dashboard, and pi agents. See [`intake-triage-design.md`](./intake-triage-design.md)
for the full design.

> **Status:** Phases 0–3 implemented — skeleton, core CRUD, AI triage
> (Bedrock + embeddings + vision), and the web dashboard (board, triage
> inbox, task detail, capture modals; served by the daemon at `/`).
> Watchlists (Phase 4) and the pi skill (Phase 5) are next.

## Layout

```
packages/
  core/     domain model: SQLite, repos, search (FTS + vector), config, event bus
  daemon/   Fastify REST API + SSE + static web serving, binds 127.0.0.1
  cli/      `task` binary — talks to the daemon over REST
  web/      React + Vite dashboard (board, triage inbox, task detail)
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

## What works now (Phases 1–3)

- **Tasks**: create, list (+ board grouping), show, edit, move (with system
  worklog), labels, refs, worklog/comment activity, soft/hard delete.
- **Intake**: capture (text + images), list, show, promote → task, link to
  existing task, discard (reason), retriage.
- **Triage (AI)**: async worker pool runs an agentic Claude pass on Bedrock —
  classify/enrich/dedup with a gate matrix (auto-create / auto-link / leave
  for review). Titan V2 embeddings + sqlite-vec power hybrid (FTS + vector,
  RRF) search; degrades to FTS-only when AWS is unreachable.
- **Web dashboard**: kanban board (drag + reorder), triage inbox (the visual
  verify-gate), task detail (editable fields, labels, refs, activity), and
  capture/new-task modals — live over SSE.
- **Daemon**: Fastify REST API, SSE event stream, health, crash recovery,
  static serving of the built web app, pidfile start/stop + launchd script.
- **Attribution**: `X-TQ-Actor` / `X-TQ-Token`; localhost is the boundary.

## Web dashboard

```bash
# dev: daemon + Vite (hot reload) together
pnpm dev:all                 # daemon :7788 + web :5173 (Vite proxies /api)

# production: build once, daemon serves it at /
pnpm build:web               # → packages/web/dist
pnpm dev                     # daemon serves the dashboard at http://127.0.0.1:7788/
```

## Develop

```bash
pnpm test          # backend (vitest, node) + web (vitest, jsdom + RTL + MSW)
pnpm typecheck     # tsc --noEmit across all packages incl. web
```

## Deploy as a launchd agent

```bash
./scripts/install-launchd.sh   # writes ~/Library/LaunchAgents/dev.tq.daemon.plist
```
