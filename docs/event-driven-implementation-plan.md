# Event-Driven Core + Extensions — Implementation Plan

> Companion to [`event-driven-architecture.md`](event-driven-architecture.md) (the *what/why* and the
> Q1–Q11 decision ledger). This doc is the *how*: ordered phases, concrete file touchpoints,
> migrations, tests, and acceptance gates. Style follows `workspaces-sessions-plan.md`.
>
> **Operational discipline (AGENTS.md), every phase:**
> - Develop against a **throwaway `TQ_CONFIG` profile** — the default DB is real data.
> - The daemon runs under `tsx` with **no watch** → **hand-restart it** after any `core`/`daemon` change.
> - Each phase ends **green** (`pnpm test` + `pnpm typecheck`) and the app still works end-to-end.
> - Migrations are forward-only, numbered `NNNN_*.sql`, applied in one tx by `runMigrations`.

> **Status: COMPLETE.** All phases A–I are implemented, green (`pnpm test` + `pnpm typecheck`),
> and verified end-to-end (triage + semantic search smoke-tested live against Bedrock). Commits:
> A `a6cde8e`, B `1e9d643`, C `359d4a9`, D `be07239`, E `4d0776b`, F `0aca616`, G `624663c`
> (+ G2 cleanup `b6375ca`), H `a2a1d6f`, I (this polish). Two deliberate deviations from the
> ledger: **(E)** no OpenAPI codegen — `@tq/contract` derives types from TypeBox (`tsc` is the
> gate); **(H)** default embedder is a zero-dep local `HashEmbedder`, with Titan as the quality
> opt-in (the `Embedder` interface stays pluggable for a future Transformers.js provider).
> The `fold(log) == state` invariant (Q10) is guarded by `packages/core/src/__tests__/replay.test.ts`.

---

## 0. Conventions established up front

- **Event author:** only the core. Clients/extensions call intent endpoints; core appends.
- **Append happens *inside* the repo's existing `db.transaction`**, alongside the state fold.
  Live bus emission happens **after commit** (carrying the persisted envelope incl. `seq`).
- **Event names:** PascalCase past-tense (`TaskMoved`). The legacy dotted SSE names (`task.created`)
  are retired in Phase D when the SSE stream is reworked.
- **Reducers are pure and shared:** the `fold(log)==state` test, future projection rebuilds, and the
  in-proc read models all reduce through the *same* per-event reducer functions (no logic duplicated
  between write-side and replay-side). Built once, in Phase C, against the stabilized catalog.
- **Actor** stays client-supplied/informal (`human:laci`, `agent:triage`); localhost is the boundary.

---

## 1. The event catalog (the irreversible part — lock before Phase B)

Envelope (Phase B migration `0007`):

```sql
CREATE TABLE event (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_seq     INTEGER NOT NULL,
  id             TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  scope_type     TEXT NOT NULL,         -- 'task' | 'intake' | 'global'
  scope_id       TEXT,
  actor          TEXT NOT NULL,
  payload        TEXT NOT NULL,         -- JSON: inline value OR {"$ref":"blob:sha256:…"}
  schema_version INTEGER NOT NULL DEFAULT 1,
  correlation_id TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_event_stream ON event(scope_type, scope_id, stream_seq);
CREATE INDEX idx_event_seq ON event(seq);
```

**Catalog v1** — `type` → payload shape, and which command emits it:

| Event | scope | payload (v1) | Emitted by |
|---|---|---|---|
| `TaskCreated` | task | `{title, body, status, priority, due_at, labels[], refs[], created_by}` | `POST /tasks`, promote |
| `TaskUpdated` | task | `{changed: {field: newValue}}` (only changed fields) | `PATCH /tasks/:id` |
| `TaskMoved` | task | `{from, to, board_rank?}` | `POST /tasks/:id/move` |
| `LabelAdded` / `LabelRemoved` | task | `{key, value}` | label endpoints |
| `RefAdded` | task | `{kind, url, external_id?, title?, meta?}` | `POST /tasks/:id/refs` |
| `WorkLogged` | task | `{description, additionalContext?}` | `POST /tasks/:id/activity` (worklog) |
| `CommentAdded` | task | `{body}` | `POST /tasks/:id/activity` (comment) |
| `TaskDeleted` | task | `{hard: bool}` | `DELETE /tasks/:id` (hard); soft = `TaskMoved→dropped` |
| `IntakeCaptured` | intake | `{source, source_ref?, event_sig?, body, action_verbs?, labels?, attachments[]}` | `POST /intake` |
| `IntakeStatusChanged` | intake | `{from, to, reason?}` | promote/link/discard/retriage |
| `IntakePromoted` | intake | `{task_id}` | promote |
| `IntakeLinked` | intake | `{task_id, relation}` | link |
| `ContextUpdated` | task\|intake | `{namespace, value \| $ref}` | `PUT …/context/:ns` |

**Rules:** a command may emit several events atomically (e.g. `promote` → `TaskCreated` +
`IntakePromoted` + `IntakeStatusChanged`). Changing any payload later = bump `schema_version` + add an
upcaster. **Pin this table in review before writing B.**

---

## Phase A — Delete workspaces & sessions

**Goal:** shrink surface before refactoring. Pure removal.

- **Delete:** core `domain/workspace.ts`, `domain/session.ts`, `workspace/provider.ts`; daemon
  `workspace/*`, `sessions/*`, `routes/workspaces.ts`; web `components/CreateWorkspaceModal.tsx`,
  `SessionList.tsx`, `SessionTranscript.tsx` (+ TaskDetail wiring); CLI `workspace`/`session`
  commands; the `[session]` block in `config.ts` (`TqConfig`, `defaultConfig`, `config.example.toml`).
- **Store:** drop `workspaces`/`sessions` repos from `Store`; remove exports from `core/index.ts`.
- **main.ts:** remove provider registry, `WorkspaceService`, scan tick, label-mirror subscriber, and
  the `workspaces`/`providers` args to `buildServer`.
- **Migration `0006_drop_workspace_session.sql`:** `DROP TABLE IF EXISTS agent_session; DROP TABLE IF
  EXISTS workspace;`
- **Delete tests:** `workspace.test.ts`, `session.test.ts`, `launcher.test.ts`, `scanner.test.ts`,
  `tasktree-provider.test.ts`, `local-provider.test.ts`, `workspace-service.test.ts`,
  `workspace-routes.test.ts`, and TaskDetail session assertions.

**Acceptance:** `pnpm test` + `pnpm typecheck` green; `GET /api/extensions`-free daemon boots; board +
triage + task detail unaffected. **Commit:** `chore: remove workspaces & sessions (revert of MVP)`.

---

## Phase B — The event spine

**Goal:** every mutation appends an immutable event in-tx and folds state as before. No behavior
change, no extensions. This is the careful one.

**core**
- **Migration `0007_event_log.sql`** (envelope above).
- **`domain/event.ts` → `EventStore`:**
  - `append(tx, {type, scopeType, scopeId, actor, payload, correlationId?}): EventRow` — computes
    `stream_seq = COALESCE(MAX(stream_seq),0)+1` for the scope, inserts, returns the row (with `seq`).
    Designed to be **called inside an open transaction**.
  - `read({since, types?, scopeType?, scopeId?, limit}): EventRow[]` and `maxSeq(): number`
    (used by Phase D and the as-of header).
- **Commit helper on `Store`:** `commit(fn): T` runs `db.transaction(fn)`, buffering events appended
  during `fn`, and **after** the tx returns, flushes them to `bus.emit(type, envelope)`. Repos switch
  from "emit after tx" to "append in tx (via EventStore) + return; Store flushes."
- **Refactor repos** (`task.ts`, `intake.ts`) so each mutation appends the catalog event(s) within its
  transaction instead of (or in addition to, transitionally) the legacy `bus.emit`. Keep the FTS
  reindex exactly where it is (it's core's in-tx projection — Q9).
- **`events.ts`:** widen the bus to carry `{event, data}` where `data` is the full envelope; keep the
  old `TqEventName` union temporarily for the existing SSE/web until Phase D.

**Tests** (`core/__tests__/event.test.ts`, plus additions to `task.test.ts`/`intake.test.ts`)
- Per-command **event-emission assertions**: each repo method → exactly the expected event row(s)
  with correct `type/scope/payload/actor`.
- `stream_seq` is contiguous per entity and gap-free across a rolled-back tx; `seq` strictly increases.
- Multi-event atomicity (promote emits its 3 events in one tx, consecutive `seq`).

**Acceptance:** all existing behavior identical; `event` table fills on every mutation; restart-safe.
**Commit:** `feat(core): append-only event log (dual seq), event-in-tx on all mutations`.

---

## Phase C — Context store, worklog-as-event, and the reducer

**Goal:** schema-free context + claim-check; activity becomes a projection; build the shared reducer
and the `fold(log)==state` invariant.

**core**
- **Migration `0008_context.sql`:** `ALTER TABLE task ADD COLUMN context TEXT NOT NULL DEFAULT '{}';`
  same for `intake`. (Blob store: **reuse the `attachment` table** as the content-addressed store;
  width/height stay nullable.)
- **`domain/blob.ts`:** generalize attachment storage into `putBlob(bytes, mime): sha256` /
  `getBlob(sha)` over `attachments_dir/<sha>` + an `attachment` row.
- **`domain/context.ts` → `ContextRepo.set(scope, id, namespace, value, actor)`:** serialize; if
  `> cfg.context.spill_bytes` (default 65536) → `putBlob` + use `{$ref}`; append `ContextUpdated`
  in-tx; fold `context[namespace] = value|ref` on the entity row. `get(scope,id)` returns the merged
  bag; resolution endpoint serves blobs.
- **Worklog/comment → events:** `TaskRepo.addActivity` appends `WorkLogged`/`CommentAdded`; the
  `activity` table becomes a **fold** of those + system events (`TaskMoved`, `IntakePromoted`, …).
  `ContextUpdated` is excluded from the timeline projection.
- **`projection/reduce.ts`:** pure per-event reducers `reduce(state, event) → state` covering task +
  intake + labels + refs + activity + context. **Used by the test below and by future rebuilds.**
- **Config:** add `[context] spill_bytes = 65536` to `TqConfig`/`defaultConfig`/`config.example.toml`.
- **Backfill (one-time):** `scripts/backfill-events.mjs` — for an existing real DB, synthesize genesis
  events from current rows (`TaskCreated`/`IntakeCaptured`/… with original timestamps) so the log is
  consistent with state and `fold(log)==state` holds. Guarded to run once (writes a `schema_meta`
  flag). Also backfill existing `intake.triage`/`triage_trace` → `context.triage` (columns retained
  until Phase G).

**daemon**
- `routes/context.ts`: `PUT /api/{tasks|intake}/:id/context/:namespace`, `GET /api/blobs/:sha`
  (+`?resolve=true`). `GET /tasks/:id` already returns the row → now includes `context` inline.

**Tests**
- `context.test.ts`: namespace-slot replace (no clobber across namespaces), claim-check spill+resolve,
  `ContextUpdated` emitted, timeline excludes context.
- **`replay.test.ts`: `fold(reduce, allEvents) == live state`** for task+intake+activity+context
  (the Q10 invariant). Runs on a seeded DB and after the backfill.

**Acceptance:** triage result/trace now mirrored in `context.triage`; activity timeline unchanged
visually but sourced from events; replay reproduces state exactly. **Commit:** `feat(core): context
store + claim-check, worklog-as-event, shared reducer + fold==state`.

---

## Phase D — Subscriptions & the durable stream

**Goal:** consumers can tail the log reliably; reads expose their as-of `seq`.

**core**
- **Migration `0009_subscription.sql`:**
  ```sql
  CREATE TABLE subscription (
    consumer_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0,
    filters TEXT, last_seen_at TEXT, dead_letters TEXT, created_at TEXT NOT NULL
  );
  ```
- **`domain/subscription.ts`:** `register/get/commit(cursor)/recordDeadLetter/list` + lag = `maxSeq − cursor`.

**daemon**
- **Rework `sse.ts` → `routes/events.ts`:** `GET /api/events?since=<seq>&types=&scope_type=` →
  query `EventStore.read` for the backlog (in `seq` order), write each as SSE, then **subscribe to the
  live bus** for the tail; filtered responses still advance past skipped events (track highest seq
  written). Retire the legacy dotted event names here; emit `{type, seq, …envelope}`.
- **As-of header:** Fastify `onSend` hook adds `X-TQ-Seq: <maxSeq>` to read responses (and `meta.seq`
  in JSON bodies where practical).
- `/api/health`: add per-consumer lag + dead-letter counts.

**web:** update `api/events.ts` to the new event shape + `since` reconnect (store last `seq`).

**Tests:** `events.test.ts` (Fastify inject): replay from `since`, filter advances cursor, live tail
after backlog, dead-letter surfaced in health. **Commit:** `feat: durable /events (since+SSE),
subscription registry, as-of seq`.

---

## Phase E — Contract package

**Goal:** one generated client/type source; kill hand-written clients.

- **`packages/contract`:** wire `@fastify/swagger` to emit `/api/openapi.json` from existing TypeBox
  route schemas; `pnpm gen` runs `openapi-typescript` → `contract/src/types.ts` + a thin typed fetch
  client + exported event type/catalog defs.
- **Repoint** `packages/web/src/api/client.ts` and `packages/cli/src/client.ts` onto the generated
  client/types (delete the hand-written `web/src/api/types.ts` duplication).
- **CI gate:** `pnpm gen --check` fails if generated output is stale.

**Tests:** a contract smoke test (generated client hits a live `inject` server for a couple routes);
typecheck across web+cli proves the repoint. **Commit:** `feat: packages/contract (OpenAPI→client),
repoint web+cli`.

---

## Phase F — Extension SDK, host, and gateway

**Goal:** the extensibility substrate.

- **`packages/extension-sdk`:**
  - `interface CoreClient` (tasks/intake commands + `context.set` + read), with **in-proc impl** (wraps
    `Store`) and **http impl** (wraps the contract client).
  - `interface EventStream` (`subscribe(consumerId, filters, handler)`), with **in-proc impl** (bus +
    `EventStore` backlog) and **http impl** (SSE `?since`).
  - `defineExtension({name, actor, subscribes, handle, onStart?, routes?})`. SDK owns: subscription
    registration, cursor commit, ordered at-least-once delivery, retry+backoff, dead-letter, opt-in
    idempotency (key `(consumer_id, event.id)`), actor stamping.
- **daemon `extensions/host.ts`:** reads `[extensions] enabled=[…]`; instantiates each with the in-proc
  `CoreClient`/`EventStream`; mounts `extension.routes` under `/api/ext/<name>/*`; serves
  `GET /api/extensions` (`{name, basePath, capabilities, uiManifest?}`). Reaction loops isolated in
  try/catch so an extension can't throw into core.
- **Config:** add `[extensions] enabled = []`.

**Tests:** `host.test.ts` (register → tail → handle → cursor commit; throw → retry → dead-letter;
gateway mount + discovery). **Commit:** `feat: extension SDK (CoreClient/EventStream), host + gateway`.

---

## Phase G — Extract triage 🎯 (the proof milestone)

**Goal:** triage becomes an SDK extension; prove the whole model end-to-end.

- **`packages/ext-triage`:** move `daemon/triage/pi-engine.ts`, `resize-image.ts`, and core
  `triage/{gate,prompt,schema,engine}.ts` here. `defineExtension`:
  - `subscribes: {types:["IntakeCaptured","IntakeRetriaged"], scope:"intake"}`.
  - `handle`: **idempotency guard** (skip if `intake.status != 'new'`); load intake (+images via
    blob store); run engine; `core.context.set("intake", id, "triage", result)`; gate → call
    `core.intake.promote|link|discard`. Trace (tier-3) → ext's own store, referenced from
    `context.triage.traceRef`.
  - dedup `search_tasks` → `GET /api/search` (core FTS) + optional `/api/ext/search` enrichment,
    degrading gracefully.
- **Delete from core/daemon:** `triage/worker.ts` (`TriageWorkerPool`), the `enqueueJob` coupling in
  `intake.ts`, the triage pool wiring in `main.ts`, `routes/jobs.ts`.
- **Migration `0010_drop_triage_job.sql`:** drop `triage_job`; drop `intake.triage`,
  `intake.triage_error`, `intake.triage_trace` (data already in `context.triage`).
- **Config:** `enabled = ["triage"]`.

**Tests:** `ext-triage` unit (mock CoreClient + engine): IntakeCaptured → context.triage written +
correct gate call; redelivery is idempotent; AWS-down → queued/dead-letter then resumes on replay.
**Acceptance:** capture an intake → triage runs as an extension → result in `context.triage` → gate
auto-creates/links exactly as before, visible in the web inbox. **Commit:** `feat: @tq/ext-triage
(event-driven); remove in-core triage worker + columns`.

---

## Phase H — Extract semantic search

**Goal:** vector/hybrid leaves core; FTS stays as the always-on core projection.

- **`packages/ext-search-semantic`:** move `search/{vector,embeddings,embedding-worker,hybrid}.ts` +
  `daemon/embeddings/titan.ts`. Projection consumer of `TaskCreated/Updated/Moved`; owns the vec index
  + `embedding_queue` + AWS-down degradation; `GET /api/ext/search` = RRF(core FTS, vec).
  **Pluggable embedder:** add `LocalEmbedder` (Transformers.js; default `bge-small`/`all-MiniLM`),
  Titan optional via config; verify exact package/model/version at this point.
- **core:** keep `search/fts.ts` as the in-tx projection; `GET /api/search` becomes FTS-only. Remove
  vec-table creation from `sqlite.ts` (moves to the extension's own store) — or leave the table but
  stop maintaining it in core; decide during build (lean: extension owns its own sqlite file).
- **Repoint:** web search box + triage dedup to `/api/ext/search` when present, else core FTS.

**Tests:** `ext-search-semantic` (replay-from-0 rebuild; hybrid fusion; degrade to FTS when embedder
absent). **Commit:** `feat: @tq/ext-search-semantic (local-default embedder); core keeps FTS`.

---

## Phase I — Polish

- `/api/health`: finalize consumer lag, dead-letter list, extension status.
- Dead-letter requeue endpoint + a small web ops affordance.
- Docs: update `README.md`, `intake-triage-design.md` cross-refs, `AGENTS.md` (new package layout).
- Dead-code sweep; ensure `fold==state` test covers the full post-extraction catalog.

**Commit:** `chore: ops polish, docs, dead-letter requeue`.

---

## 2. Risk register

| Risk | Mitigation |
|---|---|
| **Catalog churn after launch** (immutable log) | Lock §1 in review before B; upcasters for any later change; coarse domain events, not field diffs. |
| **Backfill correctness** on the real DB (C) | Run only against a throwaway profile first; `fold==state` test must pass post-backfill; one-shot guard flag; keep a DB copy. |
| **Reducer/write-side drift** | Single shared `reduce.ts`; `fold==state` test is the gate; grows with the catalog. |
| **In-proc extension crashes core** | Host isolates reaction loops (try/catch → dead-letter); extensions never imported into core. |
| **Contract repoint breakage** (E) | Land codegen first, repoint behind typecheck; CI staleness gate. |
| **Triage extraction regressions** (G) | Keep gate/prompt/schema logic byte-for-byte during the move; behavior tests carried over; idempotency guard explicit. |
| **Scope creep mid-refactor** | Each phase shippable + green; no phase depends on a later one; defer D–I detail until reached. |

---

## 3. Suggested commit sequence

`A` remove workspaces/sessions → `B` event spine → `C` context + worklog-as-event + reducer →
`D` durable /events + subscriptions → `E` contract package → `F` SDK + host + gateway →
`G` extract triage (proof) → `H` extract semantic search → `I` polish.
