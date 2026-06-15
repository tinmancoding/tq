# Intake → Triage → Task Management System — Design Doc

> Working codename: **tq** (triage queue). CLI binary: `task`. Single-user, local-first.
> Status: design complete, ready to start v1 implementation.
> Owner: Laci (dil-landrasi).

---

## 1. Overview & Goals

A personal system to capture anything (snippets, links, screenshots), let an AI
triage/enrich/dedup it, and manage the resulting tasks through a small workflow —
operable from a CLI, a web dashboard, and pi agents.

**Core flows**

1. **Capture** — paste text + images, or auto-ingest from watchlists (e.g. new GitHub PRs).
2. **Triage** — an agentic LLM pass (Claude on Bedrock, via pi SDK) classifies,
   enriches, searches for duplicates, and either suggests a task or auto-creates one.
3. **Manage** — verified tasks move through states; edited by hand, CLI, web, or pi agents.
4. **Integrate** — pi agents operate the system through the CLI/skill and log progress.

**Design principles**

- **Local-first**: one daemon on `127.0.0.1`, SQLite, no cloud control plane.
- **One contract**: a single REST API; CLI, web, pi are all equal clients.
- **Capture never blocks**: triage is async and observable.
- **Decoupled CLI**: the `task` CLI is tasktree-agnostic; takes explicit ids only.
- **Boring tech**: SQLite + in-process workers; no Redis, no external queue.

**Non-goals (v1)**

- Multi-user / off-machine / mobile capture.
- Executable task-action job runner (agents *operate* the system; they don't yet
  *execute* stored task actions). *(v2: per-task pi sessions now run real work in the
  task's workspace — see §20.)*
- Real auth — localhost binding is the security boundary.

---

## 2. Architecture

```
                          ┌──────────────────────────────────────────┐
                          │              task daemon (Node)            │
                          │            bind 127.0.0.1:<port>           │
   CLI (`task`)  ───────► │  ┌──────────┐  ┌───────────────────────┐  │
   pi skill     ───────►  │  │ REST API │  │ Triage worker pool (3) │  │
   Web (React)  ──SSE──►  │  │ + SSE    │  │  - pi SDK session      │  │
                          │  │ + static │  │  - Bedrock (Claude)    │  │
   Watchlist pollers ◄────┤  └────┬─────┘  │  - search_tasks tool   │  │
   (GitHub, …)            │       │        │  - emit_triage tool    │  │
                          │       ▼        └───────────┬───────────┘  │
                          │  ┌─────────────────────────▼───────────┐  │
                          │  │ SQLite (FTS5 + sqlite-vec)           │  │
                          │  │ intake, task, links, activity,      │  │
                          │  │ attachments(meta), triage_jobs,     │  │
                          │  │ watchlists, tokens, embeddings      │  │
                          │  └─────────────────────────────────────┘  │
                          │  Filesystem: attachments/<sha256>          │
                          └──────────────────────────────────────────┘
                                          │
                          Bedrock: Claude (triage) + Titan V2 (embeddings)
```

**Process model**: single Node process. HTTP server + scheduler (watchlist polling) +
triage worker pool all run in-process. Managed by a launchd user agent.

---

## 3. Tech Stack & Repo Layout

- **Runtime**: Node 22 + TypeScript (ESM).
- **HTTP**: Fastify (fast, schema-first, first-class JSON schema → pairs with OpenAPI).
- **DB**: `better-sqlite3` (synchronous, fast, simple) + `sqlite-vec` extension + FTS5.
- **LLM**: `@earendil-works/pi-coding-agent` SDK (`createAgentSession`, in-memory),
  provider `amazon-bedrock`.
- **Embeddings**: `@aws-sdk/client-bedrock-runtime` → Titan Text Embeddings V2.
- **Validation/contract**: TypeBox schemas → Fastify validation → OpenAPI emission →
  client/type generation (`openapi-typescript` + a thin fetch client) for web & CLI.
- **CLI**: same repo, `commander` (or `clipanion`); talks to REST.
- **Web**: React + Vite + TS, dnd-kit, TanStack Query, EventSource (SSE).
- **Test**: vitest + supertest-style Fastify inject; a few e2e CLI tests.

```
tq/
├─ package.json                 # workspaces
├─ packages/
│  ├─ core/                     # domain: db, repos, triage, search, connectors
│  │  ├─ db/                    # schema.sql, migrations/, sqlite.ts
│  │  ├─ domain/                # intake.ts, task.ts, activity.ts, types.ts
│  │  ├─ search/                # fts.ts, vector.ts, hybrid.ts, embeddings.ts
│  │  ├─ triage/                # worker.ts, session.ts, prompt.ts, tools.ts, schema.ts
│  │  ├─ connectors/            # connector.ts (iface), github.ts, registry.ts
│  │  └─ config.ts
│  ├─ daemon/                   # Fastify app, routes, SSE, scheduler, launchd
│  │  ├─ server.ts  routes/  sse.ts  scheduler.ts  static.ts
│  ├─ cli/                      # `task` binary
│  ├─ web/                      # React app (Vite)
│  └─ contract/                 # generated OpenAPI + TS client (build artifact + checked-in)
├─ skills/tq/SKILL.md           # pi skill (v1 integration)
└─ scripts/                     # dev, codegen, launchd install
```

---

## 4. Data Model (SQLite DDL)

IDs: store a **ksuid/uuidv7** text id; CLI accepts unambiguous prefixes. Timestamps
are ISO-8601 UTC text (`strftime`). Enums are validated in app code, stored as text.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────── INTAKE ───────────────────────────────
CREATE TABLE intake (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'new',        -- new|triaged|promoted|discarded
  source        TEXT NOT NULL DEFAULT 'manual',     -- manual|github|confluence|jira|...
  source_ref    TEXT,                               -- canonical external ref/url
  event_sig     TEXT,                               -- dedup key for polled events
  body          TEXT,                               -- raw pasted text (nullable)
  action_verbs  TEXT,                               -- JSON array of optional verbs
  discard_reason TEXT,                              -- noise|duplicate|irrelevant|merged
  triage        TEXT,                               -- JSON: TriageResult (see §5)
  triage_error  TEXT,                               -- last error string if triage failed
  labels        TEXT,                               -- JSON k/v applied at capture (pre-tags)
  watchlist_id  TEXT REFERENCES watchlist(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  triaged_at    TEXT,
  UNIQUE(source, event_sig)                          -- append-only idempotency for pollers
);
CREATE INDEX idx_intake_status ON intake(status);
CREATE INDEX idx_intake_created ON intake(created_at);

-- ─────────────────────────────── TASK ─────────────────────────────────
CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT,                               -- markdown
  status        TEXT NOT NULL DEFAULT 'backlog',    -- backlog|next|doing|blocked|done|dropped
  priority      TEXT,                               -- high|med|low (nullable)
  due_at        TEXT,
  snooze_until  TEXT,
  board_rank    TEXT,                               -- lexorank/fractional index for DnD ordering
  created_by    TEXT NOT NULL DEFAULT 'human:laci', -- actor that created it
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  done_at       TEXT
);
CREATE INDEX idx_task_status ON task(status);
CREATE INDEX idx_task_snooze ON task(snooze_until);

-- Namespaced k/v labels (project:aibm, person:dil-landrasi, ticket:AIBM3-56, ...)
CREATE TABLE task_label (
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (task_id, key, value)
);
CREATE INDEX idx_label_kv ON task_label(key, value);

-- Structured external references carried from intake / added by hand
CREATE TABLE task_ref (
  id       TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,                           -- github_pr|jira|confluence|url|...
  url      TEXT NOT NULL,
  external_id TEXT,                                 -- e.g. PR number, JIRA key
  title    TEXT,
  meta     TEXT                                     -- JSON (state, author, ...)
);
CREATE INDEX idx_ref_task ON task_ref(task_id);

-- many-to-many intake ⇄ task
CREATE TABLE intake_task (
  intake_id TEXT NOT NULL REFERENCES intake(id) ON DELETE CASCADE,
  task_id   TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  relation  TEXT NOT NULL DEFAULT 'source',        -- source|linked|merged
  created_at TEXT NOT NULL,
  PRIMARY KEY (intake_id, task_id)
);

-- ─────────────────────── ACTIVITY (worklog + comments + system) ───────
CREATE TABLE activity (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL,                         -- worklog|comment|system
  actor      TEXT NOT NULL,                         -- human:laci|agent:<n>|system:<conn>
  body       TEXT NOT NULL,
  meta       TEXT,                                  -- JSON (e.g. status change from->to)
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_task ON activity(task_id, created_at);

-- ─────────────────────────────── ATTACHMENTS ──────────────────────────
CREATE TABLE attachment (
  sha256     TEXT PRIMARY KEY,                      -- content address; file at attachments/<sha256>
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width       INTEGER,
  height      INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE intake_attachment (
  intake_id TEXT NOT NULL REFERENCES intake(id) ON DELETE CASCADE,
  sha256    TEXT NOT NULL REFERENCES attachment(sha256),
  filename  TEXT,
  ord       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (intake_id, sha256)
);

-- ─────────────────────────────── TRIAGE JOBS ──────────────────────────
CREATE TABLE triage_job (
  id          TEXT PRIMARY KEY,
  intake_id   TEXT NOT NULL REFERENCES intake(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'queued',       -- queued|running|done|error
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error  TEXT,
  next_run_at TEXT,                                 -- backoff schedule
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_job_status ON triage_job(status, next_run_at);

-- ─────────────────────────────── WATCHLISTS ───────────────────────────
CREATE TABLE watchlist (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  connector     TEXT NOT NULL,                      -- github|confluence|jira
  enabled       INTEGER NOT NULL DEFAULT 1,
  config        TEXT NOT NULL,                       -- JSON: connector-specific (repo, filter, jql)
  default_labels TEXT,                               -- JSON k/v applied to produced intake
  poll_interval_sec INTEGER NOT NULL DEFAULT 600,
  cursor        TEXT,                                -- last-seen marker (JSON)
  secret_ref    TEXT,                                -- name of credential in config/env
  last_polled_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

-- ─────────────────────────────── TOKENS (attribution) ─────────────────
CREATE TABLE token (
  token   TEXT PRIMARY KEY,                          -- opaque
  actor   TEXT NOT NULL,                             -- human:laci|agent:pr-reviewer|...
  created_at TEXT NOT NULL
);
-- NOTE: client-supplied actor is accepted (A); tokens are optional convenience
-- mapping. localhost binding is the real boundary.

-- ─────────────────────────────── FTS5 (keyword) ───────────────────────
CREATE VIRTUAL TABLE task_fts USING fts5(
  title, body, labels_text,
  content='', tokenize='porter unicode61'
);
-- maintained by app on task write (title + body + flattened labels)

-- ─────────────────────────────── VECTORS (sqlite-vec) ─────────────────
-- 1024-dim Titan V2 embeddings, one row per task (re-embedded on title/body change)
CREATE VIRTUAL TABLE task_vec USING vec0(
  task_id TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);

-- ─────────────────────────────── META / MIGRATIONS ────────────────────
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
```

**Embedding backfill queue**: when AWS is unreachable, tasks needing (re)embedding are
marked via a `task.needs_embedding` flag (add column) or a small `embedding_queue` table;
a periodic job drains it when connectivity returns. (Decision: simple `embedding_queue(task_id, enqueued_at)`.)

```sql
CREATE TABLE embedding_queue (
  task_id     TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  enqueued_at TEXT NOT NULL
);
```

---

## 5. Triage Pipeline

**Trigger**: `POST /intake` creates the intake (`status=new`) and a `triage_job(queued)`,
returns `202`. Workers (pool of N=3) claim queued jobs (`UPDATE ... RETURNING` with a
`running` transition guarded by a transaction).

**Per job**:

1. Load intake (body + attachments). Read image bytes from `attachments/<sha>`, base64.
2. Create an in-memory pi session on the configured Bedrock Claude model, with two
   custom tools (`defineTool`):
   - `search_tasks({ query, limit })` → calls the **hybrid search** (§6), returns
     candidate tasks (id, title, snippet, labels, status, score).
   - `emit_triage(TriageResult)` → the structured output; the agent must call this once.
3. Prompt the session with the triage system prompt + intake body + images. The agent
   may call `search_tasks` repeatedly to look for dupes/related work, then calls
   `emit_triage`.
4. Persist `TriageResult` to `intake.triage`, set `intake.status=triaged`.
5. **Gate logic** (see below) decides auto-create / auto-link / leave-for-review.
6. Mark job `done`. On exception: increment attempts, set backoff `next_run_at`,
   `error` after max.

**TriageResult (structured output schema)**

```ts
interface TriageResult {
  summary: string;                  // one-line human summary
  category: string;                 // freeform/controlled: bug|chore|review|read|idea|...
  suggested_title: string;
  suggested_body?: string;          // enriched markdown (incl. extracted text from images)
  suggested_labels: { key: string; value: string }[];
  suggested_action_verbs: string[]; // 1-2 verbs
  suggested_priority?: 'high'|'med'|'low';
  refs: { kind: string; url: string; external_id?: string; title?: string }[];
  duplicate: {
    decision: 'none' | 'weak' | 'strong';
    task_id?: string;               // best candidate
    reason?: string;
  };
  actionable_confidence: number;    // 0..1 — is this a clear, well-defined task?
  task_count_suggestion: number;    // 1 normally; >1 if intake implies multiple tasks
}
```

**Gate decision matrix** (config thresholds: `autoCreateConfidence`, default 0.8):

| duplicate.decision | actionable_confidence | Action |
|---|---|---|
| `strong` | any | **Auto-link** intake → existing task (m2m `linked`), add `system` worklog note. No new task. intake→`promoted`. |
| `weak` | any | Leave `triaged`; surface candidate(s) in review UI. |
| `none` | ≥ threshold | **Auto-create** task in `backlog`, `created_by=agent:triage`, link intake, worklog note. intake→`promoted`. |
| `none` | < threshold | Leave `triaged` for manual verify. |

- Auto-created tasks never land in `next`/`doing`.
- `task_count_suggestion > 1` always routes to manual review (don't auto-fan-out).
- All auto actions write an `activity(system)` row with provenance.

**Prompt skeleton** (`triage/prompt.ts`): role + the label vocabulary (from config) +
instructions to search before concluding duplicates + the gate semantics described as
"be conservative about duplicates" + force a single `emit_triage` call.

---

## 6. Search (Hybrid)

First-class endpoint `GET /search?q=...` used by CLI, web, and the triage `search_tasks` tool.

```
hybrid(q):
  fts_hits   = FTS5 MATCH over task_fts (BM25 rank), top Kf (e.g. 25)
  vec_hits   = sqlite-vec KNN over task_vec using embed(q), top Kv (e.g. 25)
               (skipped if AWS unreachable → FTS-only)
  fuse        = Reciprocal Rank Fusion (RRF, k=60) over the two ranked lists
  return top N tasks with fused score + which signals matched
```

- `embed(q)`: Titan V2 call (cached per query string for the request lifetime).
- Filters: `status`, `label key:value`, `has:ref`, date ranges — applied as SQL
  predicates intersected with the fused candidate set.
- Degradation: AWS down ⇒ FTS-only, response flags `vector: false` so UI can hint.

---

## 7. REST API

Base: `http://127.0.0.1:<port>/api`. JSON. OpenAPI emitted from TypeBox route schemas
(`/api/openapi.json`). Actor: optional `X-TQ-Token` header (maps to actor) or
`X-TQ-Actor` (client-supplied, default `human:laci`).

### Intake
| Method | Path | Notes |
|---|---|---|
| POST | `/api/intake` | multipart (text + images) OR json. Returns `202` + intake (`new`). `?wait=true` blocks until triaged. |
| GET | `/api/intake` | list/filter: `status`, `source`, `q`, paging. |
| GET | `/api/intake/:id` | detail incl. triage result + attachments. |
| POST | `/api/intake/:id/promote` | manual promote → create task(s) from triage suggestion (editable payload). |
| POST | `/api/intake/:id/link` | link to existing task(s). |
| POST | `/api/intake/:id/discard` | body: `{ reason }`. |
| POST | `/api/intake/:id/retriage` | requeue a triage job. |

### Tasks
| Method | Path | Notes |
|---|---|---|
| POST | `/api/tasks` | create (manual). |
| GET | `/api/tasks` | filter: `status`, `label`, `q`, `due`, paging; board view via `?group=status`. |
| GET | `/api/tasks/:id` | detail incl. labels, refs, activity, linked intakes. |
| PATCH | `/api/tasks/:id` | partial update (title/body/priority/due/snooze). |
| POST | `/api/tasks/:id/move` | `{ status, board_rank? }` — DnD + state change. |
| DELETE | `/api/tasks/:id` | (soft? → `dropped`; hard delete behind a flag). |
| POST | `/api/tasks/:id/labels` / DELETE `/api/tasks/:id/labels/:key/:value` | label mgmt. |
| POST | `/api/tasks/:id/refs` | add external ref. |
| POST | `/api/tasks/:id/activity` | `{ entry_type: worklog\|comment, body }` (worklog one-liners from pi). |
| GET | `/api/tasks/:id/activity` | timeline. |

### Search / Watchlists / Jobs / Attachments / System
| Method | Path | Notes |
|---|---|---|
| GET | `/api/search?q=` | hybrid search (§6). |
| GET/POST | `/api/watchlists` | list/create. |
| PATCH/DELETE | `/api/watchlists/:id` | edit/remove. |
| POST | `/api/watchlists/:id/poll` | force a poll now. |
| GET | `/api/triage/jobs?status=` | observability; counts + items. |
| POST | `/api/triage/jobs/:id/requeue` | re-run errored job. |
| GET | `/api/attachments/:sha256` | serve blob (immutable, cacheable). |
| GET | `/api/health` | daemon status: uptime, pool, per-watchlist last poll, AWS reachability. |
| GET | `/api/events` | **SSE** stream (§8). |

**Status codes**: `200/201/202` success; `400` validation; `404` not-found;
`409` conflict/duplicate; `422` triage/business rule; `503` AWS-dependent op while offline.

---

## 8. SSE Events (`/api/events`)

One stream; events typed by `event:` name, JSON `data:`.

- `intake.created`, `intake.triaged`, `intake.promoted`, `intake.discarded`
- `task.created`, `task.updated`, `task.moved`, `task.activity`
- `job.queued`, `job.started`, `job.done`, `job.error`, `jobs.summary` (counts: running/queued/error)
- `watchlist.polled` (name, new items count, error?)
- `daemon.status` (heartbeat every ~15s with health snapshot)

Web uses these to live-update the board, the triage inbox, and the "N triage sessions
running" indicator. TanStack Query cache invalidation keyed off event payload ids.

---

## 9. CLI (`task`)

Single binary, noun-verb, tasktree-agnostic, explicit ids, `--json` on all reads,
prefix-matchable ids, documented exit codes.

```
# intake
task intake add [--text "..."] [--image FILE]... [--label k=v]... [--verb review] [--wait]
task intake ls [--status triaged] [--json]
task intake show <id> [--json]
task intake promote <id> [--title ...] [--label k=v]... [--status backlog]
task intake link <id> --task <task-id>
task intake discard <id> --reason duplicate
task intake retriage <id>

# tasks
task add "title" [--body ...] [--label k=v]... [--priority high] [--due 2026-06-20]
task ls [--status next] [--label project:aibm] [--json]
task show <id> [--json]
task edit <id> [--title ...] [--body ...] [--priority ...] [--due ...] [--snooze ...]
task move <id> doing
task label <id> add project:aibm | rm project:aibm
task ref <id> add --kind github_pr --url ...
task log <id> "pushed changes, CI green"          # worklog one-liner (pi's main verb)
task comment <id> "longer note"
task activity <id> [--json]
task rm <id> [--hard]

# search / watchlists / daemon
task search "auth cookie" [--status ...] [--json]
task watchlist add github --name my-prs --repo org/repo --filter '...' --label project:aibm
task watchlist ls | enable <id> | disable <id> | poll <id> | rm <id>
task jobs [--status error] [--json]
task jobs requeue <id>
task daemon start | stop | status | logs
task token create --actor agent:pr-reviewer        # prints token
```

**Exit codes**: `0` ok · `1` generic · `2` not-found · `3` duplicate/conflict ·
`4` validation · `5` daemon-unreachable.

**Config resolution**: `~/.config/tq/config.toml` for daemon URL + default actor/token.
`--json` output schemas are generated from the OpenAPI types (stability contract).

---

## 10. Web Dashboard

React + Vite + TS, served by daemon at `/`. dnd-kit board, TanStack Query, EventSource.

**Routes / views**

- **Board** (`/`): kanban columns = task states; drag-n-drop reorders (`board_rank`)
  and changes status (`/tasks/:id/move`). Cards show title, labels, priority, ref chips,
  snooze/blocked badges. Live via SSE.
- **Triage inbox** (`/triage`): `new`/`triaged` intakes. Each card: raw text, rendered
  screenshots, AI summary, suggested title/labels/verbs, duplicate candidates with links.
  Actions: **Promote** (editable form), **Link to existing**, **Discard (reason)**,
  **Retriage**. This is the visual verify-gate.
- **Task detail** (`/task/:id`): editable fields, labels, refs, linked intakes,
  activity timeline (worklog + comments + system), add comment/worklog.
- **New** modals: create task; create intake (text + drag-drop images).
- **Ops bar / status** (`/status` + header widget): "N triage running / M queued /
  K errored", per-watchlist last poll + errors, AWS reachability, daemon uptime.
  Errored jobs requeue button.

State: TanStack Query as source of truth; SSE events invalidate/patch queries.
Optimistic updates on move/edit.

---

## 11. Watchlist Connectors

```ts
interface Connector {
  type: string;                                  // 'github'
  poll(config: unknown, cursor: unknown, secret: string):
    Promise<{ items: IntakeDraft[]; cursor: unknown }>;
}
interface IntakeDraft {
  source: string; source_ref: string; event_sig: string;  // → UNIQUE(source,event_sig)
  body: string; labels?: Record<string,string>;
  refs?: { kind: string; url: string; external_id?: string; title?: string }[];
}
```

- **Scheduler** (in daemon): every tick, for each enabled watchlist whose
  `last_polled_at + poll_interval` has passed, run `connector.poll`, insert intake
  drafts (idempotent via `UNIQUE(source,event_sig)` → `INSERT OR IGNORE`), enqueue
  triage jobs for new rows, update cursor + `last_polled_at`.
- **#1 connector — GitHub PRs**: config `{ repo|org, filter: opened|review-requested|... }`,
  cursor = last event timestamp / delivery id, `event_sig = "pr:<num>:<event>"`.
  Secret from `secret_ref` → env/config PAT (reuse existing Diligent GitHub token).
- Default labels per watchlist pre-tag intake (`source:github`, `repo:org/repo`).
- Deferred: Confluence comments, Jira (JQL), webhooks.

Secrets: `~/.config/tq/config.toml` `[secrets]` table or env var names referenced by
`secret_ref`; never stored in the DB.

---

## 12. Daemon Lifecycle (launchd)

- `task daemon start/stop/status/logs` wraps a launchd **user agent**
  (`~/Library/LaunchAgents/dev.tq.daemon.plist`), `RunAtLoad=true`, `KeepAlive=true`.
- Logs → `~/Library/Logs/tq/daemon.log` (rotating).
- On boot: requeue any `triage_job` stuck in `running` (crash recovery); resume scheduler.
- Port: fixed in config (default e.g. `7788`); health at `/api/health`.

```xml
<!-- dev.tq.daemon.plist (sketch) -->
<dict>
  <key>Label</key><string>dev.tq.daemon</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string><string>/path/tq/packages/daemon/dist/main.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>~/Library/Logs/tq/daemon.log</string>
  <key>StandardErrorPath</key><string>~/Library/Logs/tq/daemon.err</string>
</dict>
```

---

## 13. Configuration

`~/.config/tq/config.toml`

```toml
[daemon]
host = "127.0.0.1"
port = 7788
db_path = "~/.local/share/tq/tq.db"
attachments_dir = "~/.local/share/tq/attachments"

[triage]
provider = "amazon-bedrock"
model = "us.anthropic.claude-sonnet-4-20250514-v1:0"
concurrency = 3
max_attempts = 3
auto_create_confidence = 0.8
label_vocabulary = ["project", "person", "area", "ticket", "source", "repo"]

[embeddings]
model = "amazon.titan-embed-text-v2:0"
dims = 1024

[aws]
region = "us-east-1"
# creds from standard AWS env/profile; AWS_BEARER_TOKEN_BEDROCK supported

[client]
actor = "human:laci"
# token = "..."   # optional

[secrets]
github = { env = "GITHUB_TOKEN" }
```

AWS + pi auth: triage reuses pi's `AuthStorage`/`ModelRegistry` (reads `~/.pi/agent/auth.json`)
or standard AWS env for Bedrock; embeddings use the AWS SDK default credential chain.

---

## 14. pi Integration

> **⚠️ Superseded by §20 (Workspaces & Agent Sessions).** The binding key is the
> `Tasktree.yml` annotation **`tq.task-id`**, not `metadata.labels.task-id` as written
> below; tasktrees are linked 1:1 and tracked in tq's DB. This section is retained for
> historical context — see §20 and `docs/workspaces-sessions-plan.md` for the live design.

**v1 — skill (`skills/tq/SKILL.md`)**: documents the `task` CLI for agents. Key verbs
pi will use: `task search`, `task show`, `task add`, `task log <id> "..."`,
`task comment`, `task move`. Emphasize `--json` for parsing and explicit ids.

**Tasktree binding (in the pi layer, NOT the CLI)**: the skill instructs pi to resolve
the current task from the workspace's `Tasktree.yml`:
- read `metadata.labels.task-id` (machine binding) →
- if present, use it as the explicit id for `task log`/`task move`.
- prose context optionally in `metadata.annotations.task`.
- set via `tasktree annotate set ...` / labels; the CLI itself stays agnostic.

**Future — pi extension**: on session start, detect `Tasktree.yml labels.task-id`,
call `task show <id> --json`, and inject task context (title, body, refs, recent
activity) into the session. (Deferred.)

**Future — MCP**: thin shim over the same REST API for non-pi MCP clients. (Deferred.)

---

## 15. Security & Threat Model

- Boundary = **bind 127.0.0.1**. No off-machine access, no TLS, no real authn.
- Actor is **client-supplied** (`X-TQ-Actor`, default `human:laci`); optional token map
  for convenience. Worklog is "honest-effort history," not a tamper-proof audit.
- Secrets (GitHub PAT, AWS) live in config/env, never in the DB or attachments.
- Attachments served read-only by sha; no path traversal (lookup by hash only).

---

## 16. Observability & Ops

- `/api/health`: uptime, worker pool busy/idle, queue depth, per-watchlist last poll +
  error, AWS reachability, DB size, attachment count.
- SSE `jobs.summary` + `daemon.status` drive the web ops widget.
- Logs: structured (pino) → `~/Library/Logs/tq/`.
- Backup/export: `task export <file.tar.gz>` bundles DB + attachments dir; `task import`.

---

## 17. Build / Test / Tooling

- Monorepo (npm/pnpm workspaces). `pnpm dev` runs daemon (tsx watch) + Vite web.
- **Contract codegen**: daemon emits `openapi.json`; `pnpm gen` → TS client + types into
  `packages/contract`; web + CLI import it. CI fails if generated client is stale.
- Tests: vitest for core (db/repos/search/gate), Fastify `inject` for routes, a couple
  of CLI e2e tests against an in-memory/temp DB. Triage worker tested with a mocked pi
  session + mocked Bedrock embeddings.
- Lint/format: biome or eslint+prettier.

---

## 18. Implementation Roadmap

**Phase 0 — skeleton**
- Repo, workspaces, config loader, SQLite open + migrations runner, schema.sql.
- Fastify app, `/api/health`, launchd install script, `task daemon` commands.

**Phase 1 — core CRUD (no AI)**
- intake + task + labels + refs + activity + intake_task repos & routes.
- CLI: intake add/ls/show, task add/ls/show/edit/move/log/comment, label/ref.
- FTS5 maintenance + `/api/search` (FTS-only). SSE skeleton.
- → usable as a manual tracker.

**Phase 2 — triage**
- triage_job table + worker pool; pi SDK session; `search_tasks` + `emit_triage` tools;
  TriageResult persistence; gate matrix; `--wait`.
- Embeddings (Titan V2) + sqlite-vec + hybrid search + embedding_queue/backfill.
- Image attachments (capture → blob store → vision in triage).

**Phase 3 — web dashboard**
- React app: board (DnD), triage inbox, task detail, create modals, ops widget; SSE live.

**Phase 4 — watchlists**
- Connector interface + scheduler + GitHub PRs connector; watchlist CRUD in CLI + web.

**Phase 5 — pi skill + polish**
- `skills/tq/SKILL.md`; tasktree label binding docs; export/import; logging; backoff tuning.

**Later (deferred)**: pi context-load extension, MCP shim, Confluence/Jira connectors,
webhooks, confidence auto-promote rules, executable task-actions, unix-socket binding,
subtasks.

---

## 19. Open Questions / To Confirm During Build

- Exact GitHub PR poll filter set for connector #1 (review-requested vs authored vs all).
- Label vocabulary seed list (start: project, person, area, ticket, source, repo).
- Triage category taxonomy (freeform vs controlled) — start freeform, observe, tighten.
- Titan V2 dims: 1024 (default) vs 512 (storage) — keep 1024 unless DB size bites.
- Soft vs hard delete default for tasks (lean: `dropped` soft state; `--hard` purges).

---

## 20. Workspaces & Agent Sessions (v2)

A workspace-anchored, terminal-first agent-session layer: every task can own a **tasktree**
(strictly **1:1**), the daemon can **create it** and **launch real pi sessions** in it, and tq
**collects and reads** every pi session that ran in that workspace.

This supersedes §14's deferred "pi extension" sketch and corrects its stale assumption: the
durable task↔workspace anchor is the `Tasktree.yml` annotation **`tq.task-id`** (not
`labels.task-id`).

**Key decisions** (full design + phased plan: [`docs/workspaces-sessions-plan.md`](docs/workspaces-sessions-plan.md)):

- **Binding** by workspace **location (cwd)** — captures manually-started terminal sessions too.
- **Bidirectional storage**: tq DB link + `tq.task-id` annotation; **DB is a rebuildable cache**
  (a `scan`/reconcile rebuilds it from the tasktree registry + annotations).
- **Abstraction**: core `Workspace` entity + `WorkspaceProvider` interface (mirrors
  `TriageEngine`); daemon `TasktreeProvider` + `LocalProvider`. `roots()` is load-bearing.
- **Execution**: daemon runs non-interactive tasktree ops directly; **terminal launch via a
  config-defined launcher** (default cmux) with a print-command fallback. No command injection.
- **Sessions** are an **indexed entity** over pi's `.jsonl` store (cheap metadata; transcript on
  demand; scan-on-open + periodic tick; tombstones on file deletion). Surfaced as a Sessions
  panel + read-only transcript + Resume.
- **Interaction** via the `task` CLI taught by `skills/tq/SKILL.md`; **actor is informal
  provenance** (`agent:pi:<sessionId>`), not authz. MCP deferred.
- **Deletion** never removes worktrees/sessions on disk — the workspace row goes `detached`.
- **Post-MVP**: pi extension (context-injection + active registration); triage-driven
  declarative **source spec** (`suggested_sources` in `TriageResult`).

