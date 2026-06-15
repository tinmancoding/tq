# AGENTS.md — `tq`

`tq` (triage queue) is a personal, local-first system to capture anything, let an AI
triage/enrich/dedup it, and manage the resulting tasks through a small workflow — from a
CLI, a web dashboard, and pi agents. Architecture: an **event-driven core + extensions**
model — see `docs/event-driven-architecture.md`. (The original pre-refactor design is
`intake-triage-design.md`, partially superseded.)

**Layout** (pnpm workspace):

- `packages/core` — minimal authoritative domain: SQLite, repos, the append-only **event
  log**, the per-entity **context** store, **core FTS**, config, migrations. Sole event author.
- `packages/contract` — `@tq/contract`: public API as TypeBox schemas + derived types +
  a typed `CoreClient`. Browser-pure; the single source of truth shared by daemon/web/cli/SDK.
- `packages/extension-sdk` — `@tq/extension-sdk`: `defineExtension()` + the contract an
  extension is written against (events in; REST + context out). Never imports `@tq/core`.
- `packages/ext-triage` — `@tq/ext-triage`: AI triage (Bedrock) as an extension.
- `packages/ext-search-semantic` — `@tq/ext-search-semantic`: vector/hybrid search as an
  extension (its own sqlite-vec store; pluggable embedder).
- `packages/daemon` — Fastify REST API + durable `/events` (SSE) + the **extension host**
  + `/api/ext/<name>/*` gateway + static web serving. Binds `127.0.0.1:7788`.
- `packages/cli` — the `task` binary; talks to the daemon over REST.
- `packages/web` — React + Vite dashboard (board, triage inbox, task detail).

## Golden gotchas (these bite silently)

- **Use your own data.** There's no dev/prod separation yet — the default config points
  at the **real, in-use** DB (`~/.local/share/tq/tq.db`). Running the stack mutates live
  data. Run against your **own throwaway `TQ_CONFIG` profile** unless explicitly told to
  target the real instance. Recipe: `docs/local_development.md`.
- **Never commit credentials.** AWS/Bedrock auth lives on the host machine, not the repo.
- **Daemon runs via `tsx` with no watch.** After any change to `packages/core`,
  `packages/daemon`, or an **extension package** (`ext-triage`, `ext-search-semantic`,
  `extension-sdk`, `contract`) you **must restart the daemon by hand** — nothing reloads
  it. (Vite HMR covers the web app only.) Skipping this makes you debug a non-bug.
- **Extensions touch core only through the public API.** An extension reacts to the event
  log and calls REST + the context store via its injected `CoreClient`; it must never
  import `@tq/core` or read core's tables. That isolation is what keeps them promotable to
  separate processes — preserve it.

## Where to go next

- **Operate / verify / test / migrate** anything → `docs/local_development.md` (the shared
  ops manual).
- **Browser-driven UI verification** → the global `cmux-browser` pi skill.
- **Product overview / quick start** → `README.md`.
