# tq — triage queue

A personal, local-first system to capture anything, let an AI triage/enrich/dedup
it, and manage the resulting tasks through a small workflow — from a CLI, a web
dashboard, and pi agents.

> **Architecture:** an **event-driven core + extensions** model. A *minimal,
> authoritative core* owns task/intake state and an append-only **event log**;
> everything else — AI triage, semantic search — is an **extension** that reacts
> to events and acts back through the public API. See
> [`docs/event-driven-architecture.md`](./docs/event-driven-architecture.md) for
> the design and decision ledger, and
> [`docs/event-driven-implementation-plan.md`](./docs/event-driven-implementation-plan.md)
> for the phased build (A–I, complete). The original pre-refactor design lives in
> [`intake-triage-design.md`](./intake-triage-design.md) (partially superseded).

## Layout

```
packages/
  core/                 minimal authoritative domain: SQLite, repos, event log,
                        context store, core FTS, config, migrations
  contract/             @tq/contract — public API: TypeBox schemas + derived
                        types + typed CoreClient (browser-pure, single source of truth)
  extension-sdk/        @tq/extension-sdk — defineExtension() + the contract an
                        extension is written against (events in, REST/context out)
  ext-triage/           @tq/ext-triage — AI triage (Bedrock) as an extension
  ext-search-semantic/  @tq/ext-search-semantic — vector/hybrid search as an extension
  daemon/               Fastify REST API + durable /events (SSE) + extension host
                        + gateway + static web serving. Binds 127.0.0.1:7788
  cli/                  `task` binary — talks to the daemon over REST
  web/                  React + Vite dashboard (board, triage inbox, task detail)
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

## How it works

- **Core (authoritative).** Every task/intake mutation appends an immutable
  event to the log **and** folds current-state tables in one SQLite transaction.
  Core owns task/intake/attachments/activity, a per-entity **context** bag
  (claim-check spill for large values), and an always-on **FTS** search
  projection. It is the sole event author.
- **Event log + durable stream.** `GET /api/events?since=<seq>` replays the log
  then live-tails over SSE (gapless via `Last-Event-ID`). A server-side
  subscription registry tracks each consumer's cursor / lag / dead-letters
  (visible in `/api/health` and `/api/extensions`). Reads carry an as-of
  `X-TQ-Seq` header for snapshot-then-tail.
- **Extensions.** In-process modules (config-enabled per `[extensions.<name>]`)
  that subscribe to events and act **only** through the public API — never
  touching core internals — so each is promotable to its own process unchanged.
  They mount routes under `/api/ext/<name>/*`.
  - **`@tq/ext-triage`** — reacts to `IntakeCaptured`, runs an agentic Claude
    pass on Bedrock (classify/enrich/dedup), writes the result to
    `context.triage`, and applies a gate (auto-create / auto-link / leave for
    review) via the public API.
  - **`@tq/ext-search-semantic`** — a projection consumer that maintains its own
    vector index (sqlite-vec, its own DB) and serves hybrid search
    (RRF of core FTS + vectors). Pluggable embedder: local `HashEmbedder`
    (default, offline) or Titan/Bedrock (opt-in).
- **Web dashboard**: kanban board (drag + reorder), triage inbox (the visual
  verify-gate), task detail (editable fields, labels, refs, activity), capture
  modals — live over the event stream.
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

> **Working on tq (esp. with an agent)?** Read [`AGENTS.md`](./AGENTS.md) and
> [`docs/local_development.md`](./docs/local_development.md) for how to operate, verify,
> test, and migrate each component — and how to run against a throwaway DB instead of
> your real one (there's no dev/prod separation yet, so the default config mutates live
> data).

## Deploy as a launchd agent

```bash
./scripts/install-launchd.sh   # writes ~/Library/LaunchAgents/dev.tq.daemon.plist
```
