# Workspaces & Agent Sessions — Implementation Plan

> Adds a **workspace-anchored, terminal-first agent-session layer** to tq: every task can
> own a tasktree (1:1), the daemon can create it and launch real pi sessions in it, and tq
> collects/reads every pi session that ran in that workspace.
>
> This plan is derived from the design interview (see decision ledger below). It extends
> `intake-triage-design.md` and follows existing tq conventions:
> - **core** holds domain types, repos, and *interfaces*; **daemon** holds host-specific
>   *implementations* (mirrors `TriageEngine` in core vs `PiTriageEngine` in daemon).
> - migrations are numbered `NNNN_*.sql` applied by `runMigrations`.
> - routes are `registerXRoutes(app, store, …)`; actor via `resolveActor`; ids prefix-resolved.
> - web uses per-domain API modules in `api/client.ts`, TanStack Query keys (`qk`), and the
>   `useEventStream` SSE hook.
>
> **Operational gotcha (AGENTS.md):** the daemon runs under `tsx` with **no watch**. After any
> `packages/core` or `packages/daemon` change, **restart the daemon by hand**. Develop against a
> throwaway `TQ_CONFIG` profile — the default DB is your real data.

---

## Decision ledger (the shared understanding this plan implements)

1. **Shape.** Per-task sessions are real, full **pi coding-agent sessions in the task's workspace** (Model A), not daemon-embedded chatbots.
2. **Binding.** Sessions bind to a task **by workspace location (cwd)**, so manually-started terminal sessions are captured too.
3. **Link storage.** **Bidirectional**: tq DB holds the link; `Tasktree.yml` annotation **`tq.task-id`** is the durable anchor. **DB is a rebuildable cache.**
4. **Cardinality.** **task ↔ workspace = strictly 1:1.** All multiplicity (checkouts, branches) lives *inside* the tasktree. task → many sessions.
5. **Execution.** Daemon runs **non-interactive ops directly**; **terminal launch goes through a config-defined launcher template** (default cmux) with a print-command fallback. No free-form command injection.
6. **Abstraction.** core `Workspace` entity + `WorkspaceProvider` interface; daemon `TasktreeProvider` + `LocalProvider`. **`roots()`** is load-bearing. `info()` is an open bag. No plugin framework.
7. **Session collection.** Sessions are an **indexed entity** (rebuildable cache). Discovery = glob pi's store by path prefix under `roots()`, then confirm header `cwd`. Index = cheap metadata; transcript parsed on demand. Refresh = scan-on-open + periodic tick (no live watcher in MVP). UI = Sessions panel + read-only transcript + Resume.
8. **Interaction.** Sessions act on tq via the **`task` CLI taught by `skills/tq/SKILL.md`**. MCP deferred.
9. **Provenance.** Actor is **informal context, not authz**: `human:laci`, `agent:pi:<sessionId>` injected via `TQ_ACTOR`. No gating.
10. **Extension.** pi extension (context-injection + active registration) is **post-MVP**; MVP rides the self-bootstrap baseline.
11. **Create-tasktree.** MVP = **template-driven** (config default) + blank fallback; prefill from task; **async materialization** (`provisioning → ready` + SSE); `tq.task-id` written at init. Labels mirror **one-way → `tq.<key>` annotations** (comma-join multi-values, lossy/derived; only `tq.task-id` read back).
12. **Deletion.** Deleting/dropping a task **never removes worktrees or sessions on disk**; the workspace row goes `detached`, session rows remain as tombstones.
13. **Branch naming** for template vars: parked (codify during build).

---

## New data model (additions only)

Two migrations. Both follow the existing `ALTER`/`CREATE` style and the `_migrations` ledger.

### `0004_workspace.sql`
```sql
-- One workspace per task (strictly 1:1). DB is a rebuildable cache over the
-- tasktree registry + `tq.task-id` annotations / `.tq.json` markers.
CREATE TABLE workspace (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES task(id) ON DELETE SET NULL,  -- SET NULL ⇒ detach, never cascade-delete disk
  provider     TEXT NOT NULL,                                -- 'tasktree' | 'local'
  root_path    TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ready',                -- provisioning|ready|error|detached
  error        TEXT,
  meta         TEXT,                                         -- JSON: provider info bag (repos, template, …)
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);
-- Enforce 1:1 only for live links (a detached row sets task_id NULL).
CREATE UNIQUE INDEX idx_workspace_task ON workspace(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_workspace_path ON workspace(root_path);
```

### `0005_agent_session.sql`
```sql
-- Indexed projection of pi .jsonl sessions discovered under a task's workspace
-- roots. Source of truth for content stays the .jsonl; rows survive file deletion
-- as tombstones.
CREATE TABLE agent_session (
  id               TEXT PRIMARY KEY,           -- pi session uuid (from header)
  task_id          TEXT REFERENCES task(id) ON DELETE SET NULL,
  workspace_id     TEXT REFERENCES workspace(id) ON DELETE SET NULL,
  session_file     TEXT NOT NULL UNIQUE,       -- absolute path to the .jsonl
  cwd              TEXT NOT NULL,
  title            TEXT,                        -- first user prompt (truncated)
  model            TEXT,
  message_count    INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT,
  last_activity_at TEXT,                        -- file mtime
  status           TEXT NOT NULL DEFAULT 'seen',-- seen|active|ended (heuristic via mtime window)
  file_present     INTEGER NOT NULL DEFAULT 1,  -- 0 ⇒ tombstone (file deleted)
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_session_task ON agent_session(task_id, last_activity_at DESC);
CREATE INDEX idx_session_ws ON agent_session(workspace_id);
```

### Config additions (`TqConfig`, `defaultConfig`, `config.example.toml`)
```toml
[session]
launcher = ""                       # command template; {cwd} and {cmd} substituted. Empty ⇒ "print command" fallback.
default_cmd = "pi"                  # what the launcher runs inside the workspace
default_template = "aibm-general"   # tasktree template for "Create tasktree"; empty ⇒ blank init
pi_sessions_dir = "~/.pi/agent/sessions"
active_window_sec = 900             # mtime within this window ⇒ session shown as "active"
```

---

## Phase 0 — Foundations: types, repos, config, events

**Goal:** schema + core domain plumbing in place, nothing wired to the daemon yet. Pure, unit-testable.

**core changes**
- `db/migrations/0004_workspace.sql`, `0005_agent_session.sql`.
- `domain/types.ts`: add `Workspace`, `WorkspaceStatus`, `AgentSession`, `SessionStatus`, `WorkspaceProvider` enum-ish (`"tasktree"|"local"`).
- `domain/workspace.ts`: `WorkspaceRepo` (mirror `TaskRepo`): `create`, `get`, `getByTask`, `getByPath`, `setStatus`, `setMeta`, `detach`, `list`, `upsertFromRef`. Emits events on the bus.
- `domain/session.ts`: `SessionRepo`: `upsert(meta)`, `get`, `listForTask`, `markTombstoned(missingFiles)`, `forWorkspace`.
- `store.ts`: add `readonly workspaces: WorkspaceRepo;` and `readonly sessions: SessionRepo;` to `Store` ctor.
- `events.ts`: extend `TqEventName` with
  `workspace.created | workspace.provisioning | workspace.ready | workspace.error | workspace.detached | session.discovered | session.updated`.
- `config.ts`: add `session` block to `TqConfig` + `defaultConfig()`.
- `index.ts`: export the new repos, types, and (Phase 1) the provider interface.

**Tests** (`packages/core/src/__tests__/`)
- `workspace.test.ts`: 1:1 uniqueness (second `create` for a task conflicts), `detach` nulls `task_id` and frees the unique index, status transitions, event emission.
- `session.test.ts`: upsert idempotency by `session_file`/`id`, `listForTask` ordering by `last_activity_at`, tombstoning.

**Acceptance:** `pnpm --filter @tq/core test` green; migrations apply on a fresh `:memory:` DB; `Store` exposes the new repos.

---

## Phase 1 — Workspace abstraction + `LocalProvider`

**Goal:** prove the abstraction with the trivial provider before touching tasktree.

**core: `workspace/provider.ts`** (interface, mirrors `triage/engine.ts`)
```ts
export interface WorkspaceRef {
  provider: string;
  rootPath: string;
  name: string;
  meta?: Record<string, unknown>;
}
export interface CreateWorkspaceOpts {
  name?: string;
  template?: string;
  vars?: Record<string, string>;
  annotations?: Record<string, string>; // includes tq.task-id
}
export interface WorkspaceInfo { repos?: unknown[]; status?: unknown; [k: string]: unknown }

export interface WorkspaceProvider {
  readonly name: string;
  /** Provision on disk. May be slow (clone); callers run it async. */
  create(input: { taskId: string; opts: CreateWorkspaceOpts }): Promise<WorkspaceRef>;
  /** Adopt an existing directory. */
  attach(path: string): Promise<WorkspaceRef>;
  /** Write the durable backref + label mirror. */
  tag(ref: WorkspaceRef, annotations: Record<string, string>): Promise<void>;
  /** Read the durable tq.task-id from a path (for discovery/reconcile). */
  readTag(path: string): Promise<string | undefined>;
  /** cwd roots to launch in and to scan for sessions (root + checkout subdirs). */
  roots(ref: WorkspaceRef): Promise<string[]>;
  /** Provider-specific display bag (open/optional). */
  info(ref: WorkspaceRef): Promise<WorkspaceInfo>;
  /** Enumerate candidate workspaces on the host (for reconcile). */
  discover(): Promise<WorkspaceRef[]>;
}
```

**daemon: `workspace/local-provider.ts`**
- `create`: `mkdirSync(opts.name path under a configured base or absolute)`, then `tag`.
- `attach`: validate dir exists → `WorkspaceRef`.
- `tag`/`readTag`: read/write a `.tq.json` marker (`{ "tq.task-id": "...", labels: {...} }`).
- `roots`: `[rootPath]`.
- `info`: `{}` (or basic dir listing).
- `discover`: scan a configured base dir for `.tq.json` markers (optional; can return `[]` initially).

**daemon: `workspace/registry.ts`** — provider lookup by name (`"tasktree" | "local"`), constructed in `main.ts` and passed into `WorkspaceService` (Phase 2).

**Tests:** `local-provider.test.ts` (daemon) against a `tmpdir()` — create/attach/tag/readTag/roots round-trip.

**Acceptance:** can create a `local` workspace ref, tag it, read the tag back, and get roots — all without tasktree.

---

## Phase 2 — `TasktreeProvider`, async create, annotation mirror, reconcile

**Goal:** the real provider + the "Create tasktree…" action + DB↔disk reconcile.

**daemon: `workspace/tasktree-provider.ts`** (thin shell-out over the `tasktree` binary)
- Small `runTasktree(args, {cwd})` helper using `node:child_process` (capture stdout/stderr, non-zero ⇒ throw).
- `create`: `tasktree init <name> [--from <template>] [k=v…] --annotate tq.task-id=<id> [--apply]`. If `--apply` clones, this is the slow path (run async — see service). Resolve `rootPath` (registry or `--dir`), `name`.
- `attach`: `tasktree -C <path> root` to validate; read `Tasktree.yml metadata.name`.
- `tag`: `tasktree -C <path> annotate set tq.task-id=<id>` plus one `annotate set tq.<key>=<comma-joined>` per mirrored label.
- `readTag`: `tasktree -C <path> annotate list` → parse `tq.task-id` (or read `Tasktree.yml` directly).
- `roots`: workspace root + each checkout subdir (`tasktree -C <path> repos` → paths). Returns absolute paths.
- `info`: `{ repos: [...], status: ... }` from `tasktree repos` / `status`.
- `discover`: parse `~/.local/state/tasktree/registry.toml` (TOML) → for each path, `readTag`. Returns refs carrying any `tq.task-id`.

**core/daemon: `WorkspaceService`** (daemon orchestration; core stays binary-free)
- `createForTask(taskId, opts)`:
  1. Insert `workspace` row `status='provisioning'`, emit `workspace.provisioning`.
  2. Run `provider.create` **async** (clone may be slow); on success → `provider.tag` with `tq.task-id` + mirrored labels, set `roots`/`info` into `meta`, `status='ready'`, emit `workspace.ready`. On failure → `status='error'`, store `error`, emit `workspace.error`.
- `attachExisting(taskId, path, provider)`: `attach` → tag → insert `ready` row.
- `mirrorLabels(taskId)`: collect task labels, build `tq.<key>` map (comma-join multi-values), call `provider.tag`. **One-way, best-effort.** Subscribe to label-change/`task.updated` events (debounced) to trigger.
- `reconcile()` (`task workspace scan`): `provider.discover()` across providers → upsert/repair `workspace` rows from disk truth; mark missing as `detached`. This is what rebuilds the cache.
- `detach(taskId)`: set row `detached`, null `task_id`, optionally clear `tq.task-id` annotation. **Never deletes disk.**

**Crash recovery:** on daemon start, any `workspace.status='provisioning'` row from a previous run is suspect → re-probe disk (`readTag`/`tasktree root`); flip to `ready` if materialized else `error`. (Mirror `store.jobs.recoverRunning()`.)

**Async strategy:** keep it simple — an in-process promise per create with status transitions + SSE (no new job table needed for MVP; cloning is the only slow op and is idempotent via `tasktree apply`).

**Tests**
- `tasktree-provider.test.ts`: stub `runTasktree` (inject the exec fn) — assert correct argv for create/tag/readTag/roots; registry TOML parsing; multi-checkout roots.
- `workspace-service.test.ts`: provisioning→ready/error transitions + events; label mirror argv; reconcile upsert + detach-missing; 1:1 conflict on second create.

**Acceptance:** from a test (and manually against a throwaway profile) a task gets a real tasktree created with `tq.task-id` set; `task workspace scan` rebuilds the DB row after deleting it.

---

## Phase 3 — Session index (scanner) + REST + CLI + SSE

**Goal:** collect every pi session under a task's workspace into the `agent_session` index.

**daemon: `sessions/scanner.ts`**
- `scanForWorkspace(ws)`:
  1. `roots = provider.roots(ws)`.
  2. For each root compute pi's dir-mangle (slashes→dashes) and **glob candidate dirs by prefix** under `cfg.session.pi_sessions_dir` (catches root + checkout subdirs, e.g. `--<root>--`, `--<root>-<checkout>--`).
  3. For each `*.jsonl`, read the **header line** (`type:"session"` → `id`, `cwd`, `timestamp`) and **confirm `cwd` startsWith a workspace root** (defeats `AIBM3-219` vs `AIBM3-2199` prefix collisions).
  4. Roll-up (cheap): `message_count` (line count minus header/heuristic), `model`, `title` (first user message text, truncated), `last_activity_at` = file mtime, `started_at` = header timestamp.
  5. `sessions.upsert(...)`, emit `session.discovered` (new) / `session.updated` (changed).
  6. Mark rows whose `session_file` no longer exists as `file_present=0` (tombstone).
- `status` heuristic: `active` if mtime within `cfg.session.active_window_sec`, else `ended`.

  > **Spike note:** verify pi's exact session-dir mangling rule against `session-manager.ts` before relying on the prefix glob; the header-`cwd` confirmation makes correctness robust even if the glob is loose. A full fallback scan (read all headers, match by cwd) is acceptable for MVP volumes.

**Refresh triggers**
- Lazy: scan a task's workspace when `GET /api/tasks/:id` (or a dedicated session endpoint) is hit.
- Periodic: add a small scheduler tick in `main.ts` (`setInterval`) that scans all `ready` workspaces. (No filesystem watcher in MVP.)

**Transcript read (on demand):** `sessions/transcript.ts` — parse a full `.jsonl` into a compact step list, **reusing the `TriageTraceStep` shape / `extractTrace` approach** from `pi-engine.ts` so the web can render it with existing components.

**daemon: `routes/workspaces.ts`** (`registerWorkspaceRoutes(app, store, svc, cfg)`)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/tasks/:id/workspace` | create (`{provider?, name?, template?, vars?}`) → 202 + provisioning row |
| POST | `/api/tasks/:id/workspace/attach` | `{provider, path}` → adopt existing |
| GET | `/api/tasks/:id/workspace` | workspace row + `info()` |
| DELETE | `/api/tasks/:id/workspace` | detach (never rm disk) |
| POST | `/api/workspaces/scan` | reconcile (rebuild cache) |
| GET | `/api/tasks/:id/sessions` | scan + list index rows |
| GET | `/api/sessions/:id` | metadata |
| GET | `/api/sessions/:id/transcript` | parsed transcript (on demand) |
| POST | `/api/tasks/:id/sessions/start` | launch (Phase 5); returns `{launched}` or `{command}` fallback |

Register in `server.ts`. Use `resolveTaskId` for prefix matching and `resolveActor` consistently.

**CLI** (`packages/cli/src/index.ts`, commander)
```
task workspace create <task-id> [--provider tasktree|local] [--template T] [--name N] [--var k=v]...
task workspace attach <task-id> --path DIR [--provider ...]
task workspace show <task-id> [--json]
task workspace detach <task-id>
task workspace scan
task session ls <task-id> [--json]
task session show <session-id> [--json]
task session start <task-id>            # Phase 5
```
Wire through the existing `Client`. Reuse `EXIT` codes.

**web** (`api/client.ts`): add `workspaceApi` + `sessionApi` modules; `qk` keys; subscribe to new SSE events in `useEventStream` for cache invalidation.

**Tests**
- `scanner.test.ts`: synthetic `.jsonl` fixtures in `tmpdir()` — prefix glob + cwd confirmation, multi-checkout, tombstoning, roll-up extraction, collision rejection.
- `routes.test.ts` additions (Fastify `inject`): workspace create→202, sessions list, transcript, scan; 404 on bad id; detach.

**Acceptance:** create a workspace, run `pi` in it manually, `GET /api/tasks/:id/sessions` returns the session with correct title/model/mtime; deleting the `.jsonl` tombstones the row on next scan.

---

## Phase 4 — Web UI: Workspace section + Sessions panel + transcript

**Goal:** the reading/operating surface in the dashboard.

**`views/TaskDetail.tsx`** additions:
- **Workspace section:** if none → **"Create tasktree…"** (modal: template dropdown from config, prefilled name/vars, shows resolved command) and **"Attach existing"**. If provisioning → spinner driven by SSE. If ready → path, provider, repos/branches from `info()`, **"Start session"** + **"Reveal"** actions.
- **Sessions panel:** list from `sessionApi.list(taskId)` — title, started, last-active, msg count, model, **active badge** (heuristic). Empty-state hint. Live updates via `session.discovered/updated` SSE.
- **Transcript view:** click a session → read-only transcript (reuse triage-trace renderer) + **Resume** button (calls start endpoint with `--session <file>`).

**Components:** `CreateWorkspaceModal`, `SessionList`, `SessionTranscript`. Optimistic provisioning state; reconcile on SSE.

**Tests:** `TaskDetail.test.tsx` extensions (MSW server in `test/server.ts`) — renders sessions, opens transcript, create-workspace modal submits, provisioning→ready transition.

**Acceptance:** full round-trip visible in-browser (verify with the `cmux-browser` skill): create tasktree from dashboard → provisioning → ready; sessions appear and open.

---

## Phase 5 — Launcher + actor provenance + skill (closes MVP)

**Goal:** actually start terminal pi sessions from CLI/dashboard, attributed to an agent actor, with a skill teaching the agent to operate tq.

**Launcher** (`daemon` `sessions/launcher.ts`)
- `launch({cwd, cmd, actor})`: if `cfg.session.launcher` set, substitute `{cwd}`/`{cmd}` and `spawn` it **detached** (env includes `TQ_ACTOR=<actor>`). If unset → return `{command}` string for the UI to display/copy (**print fallback**). **No request-supplied command** — `cmd` defaults to `cfg.session.default_cmd`; only safe, fixed substitutions.
- Default cmux example documented in `config.example.toml` (e.g. open a new cmux tab `cd {cwd} && {cmd}`); macOS Terminal/iTerm fallbacks noted.
- `start` endpoint generates a correlation actor `agent:pi:<corrId>` (tq-side id; the post-MVP extension will reconcile to the real session uuid).

**Actor env override** (`packages/cli/src/client.ts` + `core/config.ts`)
- Add `TQ_ACTOR` env precedence in the CLI `Client.headers()` (env over `cfg.client.actor`). This is what makes a launched session's `task log/move` show up as `agent:pi:<id>`.
- Document `TQ_ACTOR` in config docs. Actor remains **informal context, not authz**.

**Skill** (`skills/tq/SKILL.md`)
- Teach safe verbs (`task show/search/log/comment/move/label/ref/activity`), `--json` for parsing, explicit ids.
- Self-bootstrap: read `tq.task-id` (via `tasktree -C . annotate list` or the workspace marker) → `task show <id> --json` at session start.
- Note destructive/admin verbs are out of scope (guidance, not enforcement).

**Tests:** `launcher.test.ts` — template substitution, detached spawn (mock `spawn`), print fallback when unset, env carries `TQ_ACTOR`; CLI `TQ_ACTOR` precedence test.

**Acceptance:** `task session start <id>` (and the dashboard button) opens a pi session in the workspace; worklog entries it makes show actor `agent:pi:<id>`; with launcher unset, the command string is returned for copy-paste.

**🎯 MVP complete after Phase 5.**

---

## Phase 6 — pi extension (post-MVP, "full experience")

**Goal:** remove reliance on the model self-bootstrapping; make attribution instant + exact.

- A pi extension (packaged per `docs/extensions.md`) that on session start:
  1. **Context injection:** read `tq.task-id` from the workspace (annotation/marker) → call `task show <id> --json` → inject task title/body/refs/recent activity + recent sessions into the session context.
  2. **Active registration:** POST `session.sessionFile` + `id` → a new `/api/sessions/register` endpoint so the `agent_session` row is created immediately (authoritative; the Phase-3 scan remains the fallback/gap-filler).
  3. Set the precise actor `agent:pi:<sessionId>` (reconciling the Phase-5 correlation id).
- Graceful degradation: if absent/broken, everything falls back to the Phase 3–5 baseline.

**Acceptance:** opening a session shows it knows its task without any manual `task show`; the session appears in tq instantly (no scan latency) with the real uuid.

---

## Phase 7 — Triage-driven source spec (post-MVP)

**Goal:** stop relying on templates to decide *what goes in the tasktree*.

- Add a declarative **`sources` spec** to the task model: e.g. `[{repo, branch, from?}, {copy: src→dest}, …]`.
- Extend `TriageResult` (and `TriageResultSchema`, prompt) with `suggested_sources`, so triage proposes the materials just as it proposes labels/refs today.
- `TasktreeProvider.create` learns to materialize from a `sources` spec (declarative `tasktree add` per source) instead of / in addition to a template.
- Web: edit the source spec on the task; "Create tasktree" uses it when present, else falls back to template.

**Acceptance:** a triaged task arrives with suggested sources; one click materializes the exact multi-repo/branch/copy workspace.

---

## Cross-cutting concerns & sequencing notes

- **Rebuildable-cache discipline:** both `workspace` and `agent_session` are caches over durable external truth (tasktree registry + annotations; pi `.jsonl`). Every feature must survive `DROP`-then-`scan`. Keep `reconcile()`/`scan` honest and covered by tests.
- **Degradation:** if `tasktree` binary is missing → `TasktreeProvider` ops fail cleanly and the `local` provider still works (mirror the triage/AWS degradation posture). If `pi_sessions_dir` absent → empty session list, no crash.
- **Security:** localhost bind remains the boundary (§15). The only new spawn surfaces are non-interactive `tasktree` (fixed argv) and the launcher (fixed command template + safe substitutions). No free-form command from request bodies.
- **Restart discipline:** every core/daemon phase ends with "restart the daemon" before manual verification.
- **Build order rationale:** Phase 1 (`local`) proves the seam cheaply; Phase 2 adds the real provider; Phase 3 indexes sessions (the headline "collect" feature) using only `roots()`; Phase 4 makes it visible; Phase 5 makes it launchable + attributed. 6–7 are upgrades that degrade gracefully.

## Suggested commits per phase
1. `feat(core): workspace + agent_session schema, repos, events, config`
2. `feat: WorkspaceProvider interface + LocalProvider`
3. `feat: TasktreeProvider, async create, annotation mirror, reconcile`
4. `feat: session scanner + workspace/session REST + CLI`
5. `feat(web): workspace section, sessions panel, transcript view`
6. `feat: session launcher, TQ_ACTOR provenance, skills/tq`
7. `feat: pi extension (context + registration)` *(post-MVP)*
8. `feat: triage source-spec` *(post-MVP)*
