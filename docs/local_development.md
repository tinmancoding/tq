# Local development

The operational manual for working on `tq` — how to run, verify, test, and extend
each component. `README.md` (human entry) and `AGENTS.md` (agent entry) both point
here; this is the shared hub. For UI verification in a browser, use the global
`cmux-browser` pi skill.

This doc is an *index to truth-in-code*, not a second copy of it. If a fact is
recoverable by reading the source, it lives in the source (often as a comment) and is
only pointed to here. What you'll find below is the non-discoverable stuff: workflows,
external constraints, and the few gotchas that waste a session if you don't know them.

## Contents

- [Use your own data (read this first)](#use-your-own-data-read-this-first)
- [Running the stack](#running-the-stack)
- [Per-component operation](#per-component-operation)
- [Extensions](#extensions)
- [Verifying changes](#verifying-changes)
- [Testing (3-layer strategy)](#testing-3-layer-strategy)
- [Adding a migration](#adding-a-migration)
- [External constraints index](#external-constraints-index)
- [Smoke-data hygiene](#smoke-data-hygiene)
- [Planned / not yet built](#planned--not-yet-built)

---

## Use your own data (read this first)

`tq` has **no dev/prod separation yet**. By default the daemon reads its DB and
attachments from the paths in config, which resolve to the **real, in-use instance**
(`~/.local/share/tq/tq.db`). Running `pnpm dev`/`pnpm dev:all` with the default config
mutates that live data.

**Default rule for any agent / experiment: run against your *own* throwaway config,
not the real instance — unless you've been explicitly asked to target the real one.**

Config is selected via the `TQ_CONFIG` env var (resolution order: explicit arg →
`$TQ_CONFIG` → `~/.config/tq/config.toml`). Point it at a disposable profile with its
own DB, attachments dir, and port:

```toml
# ~/.config/tq/dev.toml
[daemon]
host = "127.0.0.1"
port = 7799                                  # different port → can coexist with the real daemon
db_path = "~/.local/share/tq/dev.db"
attachments_dir = "~/.local/share/tq/dev-attachments"
```

```bash
export TQ_CONFIG=~/.config/tq/dev.toml
pnpm dev:all                                 # now hits dev.db, not the real tq.db
```

The CLI daemon controls (`task daemon start/stop/status/logs`) are profile-aware: their
pidfile/log are namespaced by the daemon port (`daemon-<port>.pid`), and the spawned
daemon inherits `TQ_CONFIG`, so a dev profile coexists with the real daemon without
colliding.

The web dev server proxies to the daemon at `http://127.0.0.1:7788` by default; if you
moved the daemon port, set `TQ_DAEMON_URL` so Vite proxies to the right place:

```bash
TQ_DAEMON_URL=http://127.0.0.1:7799 pnpm dev:all
```

Tear down a dev profile by deleting its `db_path` + `attachments_dir`.

> The migration to first-class isolation (multiple checkouts at once) is planned — see
> [Planned / not yet built](#planned--not-yet-built). Until then, `TQ_CONFIG` is the
> stopgap. Don't build an ad-hoc isolation layer.

---

## Running the stack

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs deps; builds the `better-sqlite3` native addon. |
| `pnpm dev` | Daemon only (foreground, `tsx`, no watch). Serves the **built** web app at `/` if `packages/web/dist` exists. Binds `127.0.0.1:7788`. |
| `pnpm dev:all` | Daemon (`:7788`) **+** Vite dev server (`:5173`) together, via `scripts/dev-all.mjs`. Vite proxies `/api` (incl. SSE) to the daemon. Use this for web work — HMR covers the web app. |
| `pnpm dev:web` | Vite dev server only. |
| `pnpm build:web` | Builds the web app → `packages/web/dist` (what `pnpm dev` serves). |
| `pnpm typecheck` | `tsc` across every package (core, contract, extension-sdk, ext-triage, ext-search-semantic, daemon, cli, web). |
| `pnpm test` | The CI gate: backend Vitest (node) + web Vitest (jsdom). See [Testing](#testing-3-layer-strategy). |

Ports (don't fight them):

- **Vite dev server: IPv6 `localhost:5173`** — open `http://localhost:5173`, *not*
  `http://127.0.0.1:5173`. Vite binds the IPv6 loopback by default.
- **Daemon: `127.0.0.1:7788`** (IPv4). The CLI and the Vite proxy both target it.

`README.md` also documents a launchd install (`scripts/install-launchd.sh`) for running
the daemon as a background agent for daily use.

---

## Per-component operation

- **`packages/core`** — minimal authoritative domain: SQLite (`better-sqlite3`), repos, the
  append-only **event log**, the per-entity **context** store, **core FTS** (keyword search,
  an in-transaction projection), config, migrations. Sole event author. No process of its
  own; consumed by the daemon and cli.
- **`packages/contract`** — `@tq/contract`: the public API as TypeBox schemas + `Static<>`-
  derived types + a typed `CoreClient`. Browser-pure (TypeBox only). The single source of
  truth shared by daemon validation, web, cli, and the extension SDK.
- **`packages/extension-sdk`** — `@tq/extension-sdk`: `defineExtension()` + the contract an
  extension is written against. Depends only on `@tq/contract`.
- **`packages/ext-triage`** / **`packages/ext-search-semantic`** — the two shipped
  extensions (AI triage; vector/hybrid search). See [Extensions](#extensions).
- **`packages/daemon`** — Fastify REST API + durable `/events` (SSE) + the **extension host**
  + `/api/ext/<name>/*` gateway + static serving of the built web app. Runs via `tsx` (no
  watch). Binds `127.0.0.1:7788`.
- **`packages/web`** — React 18 + Vite + TanStack Query. All styling lives in
  `packages/web/src/styles.css`. HMR via the Vite dev server.
- **`packages/cli`** — the `task` binary; talks to the daemon over REST. In dev:
  `alias task="pnpm --filter @tq/cli start --"`.

**Restart rules:**

- **Daemon runs with no watch.** After editing `packages/core`, `packages/daemon`, or any
  **extension/contract/SDK package**, you **must restart the daemon by hand** — `tsx` will
  not pick up the change. Skipping this is the classic time-sink: you "fix" something, see
  no behaviour change, and debug a non-bug. (This gotcha also lives in `AGENTS.md`.)
- **Web changes** are covered by Vite HMR under `pnpm dev:all` — no restart needed.

---

## Verifying changes

1. `errors list` (cmux browser) is the **smoke gate** — check it after any web change.
2. Use the **`cmux-browser` skill** for the interactive verify loop: navigate, click,
   fill, then `screenshot --out <png>` and **`read`** the PNG so you literally see the
   rendered UI.
3. Every interactive element carries a stable **`data-testid`** — this is the
   convention that makes both the unit tests and the cmux loop work. Add one to any new
   interactive element.

> WKWebView (what cmux drives) cannot synthesize low-level pointer input, so
> **HTML5 drag-and-drop is not automatable**. Whenever you add a draggable interaction,
> also expose a deterministic non-drag affordance (a menu/button) so it stays testable.
> Worked example in this repo: the board card drag was made verifiable by adding a
> `card-menu` button with `move-to-<status>` actions alongside the dnd-kit drag path.

---

## Testing (3-layer strategy)

**Layer 1 — Vitest (the `pnpm test` gate).**

- Backend: Vitest on `node` (`vitest.config.ts`), excludes `packages/web`.
- Web: Vitest on `jsdom` + React Testing Library + **MSW** (`packages/web/src/test/`).
- **MSW handlers must use a wildcard origin** (the handlers register against `*`, e.g.
  `*/api/intake`). jsdom runs on `http://localhost:3000`; handlers pinned to a hardcoded
  origin would 404. See `packages/web/src/test/server.ts` for the pattern, and
  `setup.ts` for the MSW lifecycle (`onUnhandledRequest: "error"` — unmocked calls fail
  the test).

**Layer 2 — cmux browser (live verify).** Interactive, against a running stack. Not a
regression suite (single shared macOS WKWebView, not CI-portable). See
[Verifying changes](#verifying-changes) and the `cmux-browser` skill.

**Layer 3 — Playwright.** Intentionally skipped for now.

---

## Adding a migration

Migrations are plain `.sql` files in `packages/core/src/db/migrations/`, applied on
daemon start. The mechanics are in `packages/core/src/db/migrate.ts` (read it — lexical
order, recorded in `_migrations`, each in a transaction, idempotent). `__dirname`
resolves to `src` because the daemon runs under `tsx`.

To add one: drop in the next lexically-ordered file (current set runs `0001_init` through
`0011_drop_embedding_queue`) and restart the daemon. For an add-column-with-backfill, copy
the shape of `0002` / `0003`; for a data-move-then-drop-column, see `0010` (moves the dead
`intake.triage*` columns into the context bag via `json_set`, then drops them).

> **Migration immutability.** Past migrations are history — don't edit them. The numbering
> also has gaps (`0004`/`0005` were the deleted workspaces/sessions migrations); that's
> expected. Virtual tables (e.g. an old `task_vec`) can't be dropped without the sqlite-vec
> module loaded, which core no longer loads — leave such inert tables alone.

---

## External constraints index

Facts you **cannot** derive from this repo no matter how carefully you read it — they
live outside it. Each is anchored at its code site; this is just the map.

- **Bedrock rejects images with any dimension > 8000px**, and Anthropic downscales past
  ~1568px on the long edge anyway. We cap the long edge at 1568px before sending. →
  `packages/ext-triage/src/resize-image.ts` (the rationale is in the file header
  comment). This was the single most expensive debugging detour in the project's
  history; do not remove the resize.

Everything else about triage/trace/status is recoverable from the source and is *not*
duplicated here:

- Triage runs in `@tq/ext-triage`; its result + transcript are written to the intake's
  context bag (`context.triage` / `context.triage_trace`) and surfaced by `GET
  /api/intake/:id/trace` → see `packages/ext-triage/src/extension.ts` and
  `packages/daemon/src/routes/intake.ts`.
- `task.status_changed_at` (advances only on real status change; rank-only moves don't
  reset it) → see migration `0003` and the move handler in
  `packages/daemon/src/routes/tasks.ts`.

---

## Smoke-data hygiene

If you *do* run against the real instance (you were asked to, or you skipped the dev
profile), clean up what you create so the live data stays sane:

- Hard-delete tasks you made: `task rm <id> --hard` (or REST `DELETE
  /api/tasks/:id?hard=true`). Soft delete (`task rm <id>`) just drops them to a `dropped`
  state; `--hard` / `?hard=true` purges.
- Discard intakes you captured.

There is currently **no intake-delete endpoint** — discard is the only path. Prefer a
`TQ_CONFIG` dev profile to avoid the cleanup problem entirely.

---

## Extensions

Triage and semantic search are **extensions**, not core code. The model (full design:
`docs/event-driven-architecture.md`):

- An extension is a `defineExtension({ name, setup })` module (`@tq/extension-sdk`). In
  `setup` it registers **event handlers** (`ctx.on({types,scopeType}, handler)`) and
  optional **HTTP routes** (`ctx.route(...)`, mounted at `/api/ext/<name>/*`). It acts on
  core **only** through the injected `ctx.core` (`@tq/contract`'s typed `CoreClient`) and
  the context store — never importing `@tq/core` or reading its tables.
- The **host** (`packages/daemon/src/extensions/host.ts`) boots the extensions enabled in
  `[extensions.<name>]`, gives each a durable subscription (replays the log from its
  committed cursor, then live-tails), processes events in `seq` order, and dead-letters a
  persistently-failing handler past the poison (at-least-once + idempotent). Cursor / lag /
  dead-letters are observable at `GET /api/extensions` and in `/api/health`.
- **Hosting is in-process today** but the isolation rule (public API only) means an
  extension is promotable to its own process unchanged. Keep that rule intact.

The two shipped extensions:

- **`@tq/ext-triage`** — reacts to `IntakeCaptured` / `IntakeRetriaged`, runs the agentic
  Claude pass on Bedrock, writes `context.triage`, and applies the gate
  (auto-create / auto-link / leave-for-review) via the public API. Idempotency guard: skips
  intakes not in `new`. Engine failure records `context.triage_error` and leaves the intake
  `new` (manual `task intake retriage` re-runs it) — there is no per-item backoff queue.
- **`@tq/ext-search-semantic`** — a projection consumer that maintains its **own** sqlite
  store (separate file + sqlite-vec) by embedding tasks on `TaskCreated`/`TaskUpdated`. Its
  index is rebuildable from scratch by replaying the task stream from seq 0. Serves
  `GET /api/ext/search-semantic/search` = RRF(core FTS, its vectors), degrading to FTS-only
  when the embedder fails. Pluggable embedder via `[embeddings] provider` (`local`
  HashEmbedder, default/offline; `titan` Bedrock).

**To add an extension:** create `packages/ext-<name>` depending on `@tq/extension-sdk` +
`@tq/contract`, export a `defineExtension` factory, add it to the daemon's `available` list
in `packages/daemon/src/main.ts`, enable it in config, and **restart the daemon**.


## Planned / not yet built

- **Parallel multi-checkout local dev** — being able to run several local checkouts at
  once for fast iteration/experimentation. Intended approach: **docker-compose + a
  Makefile**. Not built yet. Until it lands, isolate with a `TQ_CONFIG` dev profile
  (see [Use your own data](#use-your-own-data-read-this-first)). **Don't** invent an
  ad-hoc isolation scheme that would conflict with this direction.
