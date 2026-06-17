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
git clone git@github.com:tinmancoding/tq.git ~/.tq
cd ~/.tq
pnpm install
make install   # builds web, seeds config/, installs task shim + launchd agent
```

The `task` CLI shim is installed to `~/.local/bin/task`. Make sure that's on your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"  # add to your shell profile
```

Add credentials to `~/.tq/config/tq.env` (created automatically; already `chmod 0600`):

```bash
# ~/.tq/config/tq.env
ATLASSIAN_EMAIL=you@company.com
ATLASSIAN_API_TOKEN=your_atlassian_api_token
AWS_PROFILE=your_aws_profile
```

After `git pull`, rebuild and restart:

```bash
cd ~/.tq && git pull && make update
```

To uninstall the launchd agent and CLI shim (data/config preserved):

```bash
make uninstall
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

## Using the CLI

```bash
task add "Fix auth cookie bug" --label project:aibm --priority high
task ls
task move <id> doing
task log <id> "pushed changes, CI green"
task search "auth cookie"

task intake add --text "Review PR 123 for the auth fix"
task intake ls
task intake promote <id> --title "Review PR 123"
```

## Develop

```bash
pnpm install           # installs deps + builds the better-sqlite3 native addon
pnpm dev               # daemon (foreground, port 7799, data at <checkout>/data)
pnpm dev:all           # daemon :7799 + Vite dev server :5173
pnpm test              # backend + web tests
pnpm typecheck         # tsc across all packages
```

Dev checkouts default to `<checkout>/data/` (sandbox) and port **7799**, so they never
touch the production data at `~/.tq`. See `docs/local_development.md`.
