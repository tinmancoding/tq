# AGENTS.md — `tq`

`tq` (triage queue) is a personal, local-first system to capture anything, let an AI
triage/enrich/dedup it, and manage the resulting tasks through a small workflow — from a
CLI, a web dashboard, and pi agents. Full design: `intake-triage-design.md`.

**Layout** (pnpm workspace):

- `packages/core` — domain model: SQLite, repos, hybrid search (FTS + vector), config,
  event bus, migrations.
- `packages/daemon` — Fastify REST API + SSE + static web serving. Binds `127.0.0.1:7788`.
- `packages/cli` — the `task` binary; talks to the daemon over REST.
- `packages/web` — React + Vite dashboard (board, triage inbox, task detail).

## Golden gotchas (these bite silently)

- **Use your own data.** There's no dev/prod separation yet — the default config points
  at the **real, in-use** DB (`~/.local/share/tq/tq.db`). Running the stack mutates live
  data. Run against your **own throwaway `TQ_CONFIG` profile** unless explicitly told to
  target the real instance. Recipe: `docs/local_development.md`.
- **Never commit credentials.** AWS/Bedrock auth lives on the host machine, not the repo.
- **Daemon runs via `tsx` with no watch.** After any `packages/core` or `packages/daemon`
  change you **must restart the daemon by hand** — nothing reloads it. (Vite HMR covers
  the web app only.) Skipping this makes you debug a non-bug.

## Where to go next

- **Operate / verify / test / migrate** anything → `docs/local_development.md` (the shared
  ops manual).
- **Browser-driven UI verification** → the global `cmux-browser` pi skill.
- **Product overview / quick start** → `README.md`.
