# Event-Driven Core + Extensions — Architecture Design

> **Status:** design agreed (interview with Laci, 2026-06-15), ready to plan implementation.
> **Supersedes:** the in-daemon orchestration model in `intake-triage-design.md` (triage worker
> pool, in-core search, workspaces/sessions) and **fully replaces** `docs/workspaces-sessions-plan.md`
> (workspaces/sessions are removed; see §10).
>
> **One-line vision:** a *minimal, authoritative core* that owns task/intake state and an
> append-only event log; everything else (triage, semantic search, future workspaces) is an
> **extension** that reacts to events and acts back through the public API. Choreography, not
> orchestration.

---

## 0. Decision ledger (the authoritative record)

| # | Decision |
|---|---|
| **Q1** | **Truth model = transactional log + synchronous read model.** Every mutation appends an immutable event row *and* folds current-state tables in **one `better-sqlite3` transaction**. The log is the durable, ordered, replayable spine; state tables stay authoritative for reads. Rebuild-from-log is possible but off the hot path. (Not pure event-sourcing; not lossy outbox.) |
| **Q2** | **Minimal core** owns: `task`, `intake`, `attachments`, `activity`, the **event log**, the **context store**, and **core FTS**. **Evicted to extensions:** triage (AI), semantic/vector search, watchlists. **Deleted entirely:** workspaces, sessions. Couplings severed: `intake.create` no longer enqueues triage; `TaskRepo` no longer inline-reindexes/embeds; promote stays core but is *triggered* by the triage extension via API. |
| **Q3** | **Context = schema-free bag embedded on the entity**, namespace-slot-replace, folded `context` JSON column, mutated **only** via `ContextUpdated`. Worklog/timeline = `WorkLogged`/`CommentAdded`/system events folded into `activity`; context updates filtered out of the human timeline. **Claim-check** spill >~64 KB to the content-addressed blob store, store `$ref`, resolve on demand. **Three-tier payload rule:** small→inline, one-shot large→spill, append-heavy→extension's own store. |
| **Q4** | **Core is the sole event author.** Clients/extensions call intent-shaped endpoints; core validates and appends. One command may append **multiple events atomically**. **Single physical global log** with **dual sequence**: global `seq` (the pub/sub cursor) + per-entity `stream_seq` (gap-detection + optimistic concurrency). PascalCase past-tense event names. |
| **Q5** | **Subscription contract:** `GET /api/events?since=<seq>` replay → SSE live tail, server-side type/scope filters (response reports highest `seq` scanned). **At-least-once + idempotent consumers.** Retry w/ backoff → **dead-letter past poison** (no head-of-line block). **Server-side durable `subscription` registry** (cursor/lag/dead-letters observable in `/health`). Read-model responses carry their **as-of `seq`** → snapshot-then-tail bootstrap. |
| **Q6** | **Extension** = registered subscriber that touches core **only** via log + REST + context (hard rule), has an actor identity, may keep its own store/HTTP surface. **MVP hosting = in-process modules** (separate packages, daemon-loaded, config-enabled), promotable to separate processes later with no abstraction change. **`@tq/extension-sdk`** (`defineExtension` + injected `CoreClient`/`EventStream`; SDK owns subscription/cursor/retry/dead-letter/idempotency/actor). Forces building **`packages/contract`** (OpenAPI→generated client/types) now. |
| **Q7** | **Single-origin gateway:** extensions mount under **`/api/ext/<name>/*`** (in-proc mount → out-of-proc proxy; core only routes). **`/api/extensions`** discovery for client-side composition. Inline-context for cheap per-entity data; extension endpoints for relational/heavy reads. Dynamic frontend plugins deferred (built-in panels gated on presence for now). |
| **Q8** | **Triage → `@tq/ext-triage`** (delete `triage_job` + worker pool; idempotency guard on `intake.status`). **Workspaces/sessions → deleted** (drop migration `0006`; plan kept as future-extension blueprint). **Cross-extension calls go through public gateway endpoints with graceful degradation** (no inter-extension imports). |
| **Q9** | **Search is split.** **Core keeps FTS keyword search** over task+intake as a **synchronous in-transaction projection** (zero external deps, always consistent, offline). **`@tq/ext-search-semantic`** owns vector/hybrid as a rebuildable projection consumer, with a **pluggable, local-default embedder** (Transformers.js / `all-MiniLM`/`bge-small` default; Titan/Bedrock optional). Triage dedup uses core FTS (always present) + optional semantic enrichment. |
| **Q10** | **Log evolution:** per-type `schema_version` + **upcasters** (never rewrite history). **Full log retained forever** (single-user volume). **Projections replay-from-0 rebuildable**; **core state authoritative** with a **test-only `fold(log)==state`** check (no operational core rebuild). Snapshots/compaction deferred. |
| **Q11** | **Strangler-fig refactor sequence** (state stays authoritative throughout): A delete workspaces/sessions → B lay the event spine → C context + worklog-as-event → D subscriptions → E contract package (+ repoint web/CLI) → F SDK + host + gateway → **G extract triage (proof milestone)** → H extract semantic search → I polish. |

---

## 1. Architecture

```
                  ┌─────────────────────────── task daemon (single Node process) ───────────────────────────┐
                  │                                                                                          │
  CLI (`task`) ──►│  ┌────────────────── CORE (minimal, authoritative) ──────────────────┐                  │
  Web (React) ───►│  │  Intent REST API  →  validate → [append event(s) + fold state]tx   │                 │
                  │  │  • task / intake / attachments / activity                          │                 │
                  │  │  • context store (schema-free, per-namespace, claim-check spill)    │                 │
                  │  │  • core FTS (in-tx projection over task+intake)                     │                 │
                  │  │  • event log  (global seq + per-entity stream_seq)  ◄── source of  │                  │
                  │  │  • subscription registry (durable cursors, lag, dead-letters)       │     pub/sub     │
                  │  │  GET /api/events?since=<seq>  → replay → SSE live tail               │                 │
                  │  └───────────────▲───────────────────────────────┬───────────────────┘                 │
                  │                  │ commands + context (REST)       │ tail (SDK: CoreClient + EventStream) │
                  │   ┌──────────────┴───────────┐      ┌──────────────▼───────────────┐                     │
  Gateway:        │   │ @tq/ext-triage           │      │ @tq/ext-search-semantic       │   (in-proc modules │
  /api/ext/<n>/*  │   │  consume IntakeCaptured  │      │  consume Task* → vec index    │    today; same     │
  /api/extensions │   │  → context.triage        │      │  /api/ext/search (hybrid)     │    contract        │
                  │   │  → promote/link/discard  │      │  pluggable local embedder     │    out-of-proc     │
                  │   └──────────────────────────┘      └───────────────────────────────┘   tomorrow)       │
                  └──────────────────────────────────────────────────────────────────────────────────────┘
                                                       │
                       SQLite (WAL): task, intake, activity(projection), context(cols),
                       event log, subscription, core FTS, attachments(meta) + blob store
```

---

## 2. The core (minimal, authoritative)

The core's single job: **turn validated intents into a correct, ordered, durable fact log, and keep authoritative read models in sync — atomically.** It owns nothing derived, external, async, or optional.

**Owns:** `task` (+labels/refs/lifecycle), `intake` (+attachments, lifecycle status), `activity`
(timeline projection), the **event log**, the **context store**, **core FTS**, the **subscription
registry**, and the content-addressed **blob store** (generalized from `attachment`).

**Does not know about:** triage, semantic search, embeddings/AWS, or any extension. It never calls
out to them; it only publishes facts they may react to.

### 2.1 Write path (every mutation)
```
POST /tasks/:id/move  → validate command
  └─ db.transaction:
       append event(s)  (assign global seq via AUTOINCREMENT; compute stream_seq = MAX+1 per entity;
                          claim-check spill payload >~64KB → blob ref)
       fold state       (update task row, core FTS, context column, activity projection as applicable)
  └─ after commit: wake in-proc EventBus (carries seq) → SSE live tailers
```
- Single writer (`better-sqlite3`, one process) ⇒ both sequences are race-free with no app-level
  locking. Never order by wall-clock time.
- A command may emit several events (e.g. `promote` → `TaskCreated` + `IntakeLinked` +
  `IntakeStatusChanged`) — all atomic, consecutive `seq`.

### 2.2 Read path
- Reads come from authoritative state tables (no projection lag).
- **Every read-model response carries its as-of global `seq`** (`X-TQ-Seq` header / `meta.seq`) so a
  consumer can do **snapshot-then-tail** (read current state, then `?since=<seq>`) with no gap.
- `GET /task/:id` returns the entity **with `context` inline**: `{ ...task, context: { triage: {...},
  search: {...} } }`. This is what makes UI composition trivial for cheap per-entity data.

---

## 3. Event log

```sql
CREATE TABLE event (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- GLOBAL order = pub/sub cursor
  stream_seq     INTEGER NOT NULL,                   -- PER-ENTITY version (1,2,3… per scope)
  id             TEXT NOT NULL UNIQUE,               -- ksuid; idempotency/dedup
  type           TEXT NOT NULL,                      -- PascalCase past-tense, e.g. 'TaskMoved'
  scope_type     TEXT NOT NULL,                      -- 'task' | 'intake' | 'global'
  scope_id       TEXT,                               -- aggregate id
  actor          TEXT NOT NULL,                      -- provenance (human:laci | agent:triage | …)
  payload        TEXT NOT NULL,                      -- JSON: inline value OR { "$ref": "blob:sha256:…" }
  schema_version INTEGER NOT NULL DEFAULT 1,         -- per-type, for upcasting
  correlation_id TEXT,                               -- optional: trace command/reaction chains
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_event_stream ON event(scope_type, scope_id, stream_seq);
CREATE INDEX idx_event_seq ON event(seq);
```

- **Global `seq`** = total order + the only cursor consumers track. **Per-entity `stream_seq`** =
  contiguous `1..N` for committed history (rolled-back appends consume no number) ⇒ trivial
  per-entity gap detection + optimistic-concurrency (`expectedVersion`).
- **Single physical log**, never physically partitioned. A "per-task stream" is just
  `WHERE scope_type/scope_id ORDER BY stream_seq`.

**Starter event catalog** (extend as needed; bump `schema_version` + add upcaster on change):
`IntakeCaptured`, `IntakeStatusChanged`, `IntakePromoted`, `IntakeLinked`, `IntakeDiscarded`,
`IntakeRetriaged`, `TaskCreated`, `TaskUpdated`, `TaskMoved`, `LabelAdded`, `LabelRemoved`,
`RefAdded`, `WorkLogged`, `CommentAdded`, `ContextUpdated`.

---

## 4. Context store (schema-free per-entity bag)

- Physical: a folded **`context` JSON column** on `task` and `intake`. Logical: a map of
  **namespace → value**, one namespace per extension (`triage`, `search`, future `workspace`).
- Mutated **only** via `PUT /api/{tasks|intake}/:id/context/:namespace` → core validates (size,
  namespace) → appends `ContextUpdated{ scope, scopeId, namespace, value, actor }` → fold sets
  `context[namespace] = value` (**replace that slot only** — never deep-merge, never blob-replace,
  so concurrent extensions never clobber each other).
- **Claim-check:** if serialized `value` > ~64 KB, spill to the content-addressed blob store and
  store `{ "$ref": "blob:sha256:…", bytes, encoding }` in both event and column; `GET /api/blobs/:sha`
  (or `?resolve=true`) fetches on demand. Reads return the `$ref` envelope by default (cheap).
- **Three-tier rule:** (1) small structured state → inline; (2) one-shot immutable large result →
  auto-spill; (3) append-heavy/streaming/mutable-large → the **extension's own store**, referenced
  by stable id (never poured through `ContextUpdated`).

---

## 5. Activity / worklog (a projection, not a table you hand-write)

- `WorkLogged{actor, timestamp, description, additionalContext}`, `CommentAdded`, and system events
  (`TaskMoved`, …) are the source. The `activity` timeline is **folded** from them.
- `ContextUpdated` is **in the log but filtered out** of the human timeline by default (machine
  chatter); the timeline shows worklog/comment/status only.

---

## 6. Subscription contract (pub/sub)

- **Endpoint:** `GET /api/events?since=<seq>[&types=…&scope_type=…]` → events with `seq > cursor` in
  order, then **holds open as SSE** to live-tail. Filtered responses report the **highest `seq`
  scanned** so consumers advance past skipped events.
- **Durable registry:** `subscription(consumer_id, cursor, last_seen_at, dead_letters, …)`. Consumers
  register an id and commit their position; `/health` exposes per-consumer lag + dead-letters.
- **Semantics:** at-least-once, ordered by global `seq`, **idempotent consumers** (key on event
  `id`). Failure → retry w/ backoff; after max attempts → **dead-letter the event and advance** (no
  head-of-line block). This generalizes the old `triage_job` retry/`max_attempts`/`last_error`.
- **Bootstrap modes:** *replay-from-0* (rebuild a projection) or *snapshot-then-tail* (read state +
  its as-of `seq`, tail forward — no history replay).

---

## 7. Extensions & the SDK

**Anatomy (hard rule):** an extension interacts with core **only** through the event log + public
REST API + context store — never core internals, tables, or functions. It (1) registers a durable
subscription, (2) reacts via commands + context writes, (3) optionally keeps its own store, (4)
optionally exposes an HTTP/UI surface under the gateway, (5) carries an actor identity.

**Hosting:** **in-process modules** (separate packages, daemon-loaded, `[extensions] enabled=[…]`),
promotable to separate OS processes later **with no code change** — because the SDK depends on two
interfaces whose only difference across deployments is transport.

```ts
// @tq/extension-sdk
export const triage = defineExtension({
  name: "triage",
  actor: "agent:triage",
  subscribes: { types: ["IntakeCaptured", "IntakeRetriaged"], scope: "intake" },
  async handle(event, core /* typed CoreClient: commands + context */) {
    const intake = await core.intake.get(event.scopeId);
    const result = await runTriage(intake);                     // extension's own logic + own store for trace
    await core.context.set("intake", intake.id, "triage", result);
    if (result.autoCreate) await core.intake.promote(intake.id, {/*…*/});
    // throw ⇒ retry w/ backoff; return ⇒ ack + advance cursor
  },
});
```

SDK owns: subscription/`consumer_id` registration, cursor tracking, ordered at-least-once delivery,
retry→dead-letter, opt-in idempotency helper keyed on `(consumer_id, event.id)`, actor stamping,
typed config slice. **`CoreClient` + `EventStream`** have an **in-proc impl** (bound to the bus +
direct store calls) and an **HTTP/SSE impl** — the only thing that differs between deployment modes.

**Contract package (`packages/contract`):** TypeBox route schemas → OpenAPI → generated TS client +
event/type defs. Consumed by the in-proc `CoreClient`, the HTTP `CoreClient`, the CLI, and the web
app. Kills the "API contract lives implicitly in three hand-written places" problem; CI fails on
stale generation.

---

## 8. Gateway & composition

- Extensions mount HTTP under **`/api/ext/<name>/*`** (in-proc: register routes on the shared
  Fastify instance; out-of-proc later: daemon proxies). Same URL space either way → client code is
  transport-agnostic too.
- **`GET /api/extensions`** lists `{ name, basePath, capabilities, uiManifest? }`. Web/CLI compose
  conditionally (render the Sessions panel only if present, wire the search box to `search`, etc.).
- **Read-data division:** cheap per-entity → inline `context`; relational/heavy (lists, transcripts,
  hybrid search) → extension endpoints. Dynamic third-party frontend plugins are post-MVP.

---

## 9. Search (split)

- **Core FTS** (`GET /api/search?q=` over task+intake): SQLite FTS5, maintained as a **synchronous
  in-transaction projection** — always consistent, offline, zero external deps. The capability you
  never lose.
- **`@tq/ext-search-semantic`** (`GET /api/ext/search`): tails `Task*`, maintains its own sqlite-vec
  index + RRF hybrid fusion with core FTS; rebuildable replay-from-0; **pluggable embedder**
  defaulting to a **local model (Transformers.js: `all-MiniLM-L6-v2` / `bge-small-en-v1.5`)**, Titan
  optional via config. Absent/behind ⇒ core keyword search still works.

---

## 10. Removed: workspaces & sessions

Deleted entirely (core `domain/workspace.ts`, `domain/session.ts`, `workspace/provider.ts`; daemon
`workspace/*`, `sessions/*`, `routes/workspaces.ts`; web workspace/session components; CLI
workspace/session commands; `[session]` config; drop migration `0006_drop_workspace_session.sql`).
`docs/workspaces-sessions-plan.md` is retained **only as a revival blueprint**: when usage warrants,
it returns as **`@tq/ext-workspaces`** built on the SDK + gateway pattern — **never in core**.

---

## 11. Durability & evolution

- **Schema evolution:** bump per-type `schema_version`, register an upcaster `(type, vN)→vN+1`
  applied on read/replay. History is never mutated.
- **Retention:** keep the full log forever (revisit only if volume bites).
- **Rebuild:** all projections (core FTS, semantic index, extension read models) support
  replay-from-0. Core state stays authoritative; equivalence enforced as a **test-only
  `fold(log)==state`** check (no operational core rebuild).
- **Deferred:** snapshots, compaction.

---

## 12. Implementation sequence (strangler-fig)

State stays authoritative throughout; the log is additive until extensions consume it. Each phase
ends green + daemon hand-restarted; develop against a throwaway `TQ_CONFIG` profile.

| Phase | Goal | Key deletions/additions |
|---|---|---|
| **A** | Delete workspaces/sessions | drop migration `0006`; remove all WS/session code |
| **B** | Lay the event spine | `event` table; `appendEvent` (dual seq); every repo mutation appends-in-tx; bus driven off events; `fold(log)==state` test |
| **C** | Context + worklog-as-event | `context` columns; `ContextUpdated` + `PUT …/context/:ns` + claim-check; `activity` → projection; backfill `intake.triage*` → `context.triage` |
| **D** | Subscriptions | `subscription` registry; `GET /events?since` replay→SSE + filters; as-of `seq` on reads |
| **E** | Contract package | `packages/contract` (OpenAPI→client/types); repoint web + CLI; CI staleness gate |
| **F** | SDK + host + gateway | `@tq/extension-sdk`; daemon extension host (config-enabled); `/api/ext/*` + `/api/extensions` |
| **G** 🎯 | **Extract triage** (proof) | `@tq/ext-triage` on SDK; **delete `triage_job` + worker pool + `intake.triage*` cols**; idempotency guard |
| **H** | Extract semantic search | `@tq/ext-search-semantic` (local-default embedder); core FTS stays; repoint search + triage dedup to gateway |
| **I** | Polish | `/health` lag/dead-letter metrics; docs; dead-code sweep |

**Proof milestone = G:** triage as an extension exercises every new seam (event consumption, context
writes, commands back to core, idempotency, retry/dead-letter). When it works end-to-end, the
architecture is validated; semantic search (H) follows the proven path.

---

## 13. Open / deferred

- Dynamic/third-party **frontend plugins** (extension-provided UI bundles).
- **Out-of-process** extension deployment (contract already supports it; flip the injected transport).
- **Snapshots / compaction / retention pruning** (scale features).
- **Workspaces/sessions** revival as `@tq/ext-workspaces`.
- Exact local-embedding **package/model/version** selection (verify at build time in Phase H).
