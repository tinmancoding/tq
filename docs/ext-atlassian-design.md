# `@tq/ext-atlassian` + Triage Enrichment — Architecture Design

> **Status:** **implemented** — all phases (A–F) built; no live API in the working tree
> (work is uncommitted). Companion plan:
> [`ext-atlassian-implementation-plan.md`](ext-atlassian-implementation-plan.md).
> **Builds on:** the event-driven core + extensions model in
> [`event-driven-architecture.md`](event-driven-architecture.md) (esp. Q6 extension contract,
> Q7 single-origin gateway, Q8 cross-extension calls via gateway w/ graceful degradation).
>
> **One-line vision:** give the triage agent first-class access to the Jira/Confluence content
> an intake refers to — *automatically dereference links & mentions*, and *let the agent search
> and read on demand when prefetch misses* — delivered as the **first source-connector
> extension**, a reusable pattern for future GitHub/Glean/etc. connectors.

---

## As-built deviations

The following ledger records decisions that shifted during implementation.
See the companion plan for phase-level notes; these are the cross-cutting deltas.

| # | Design intent | As-built reality |
|---|---------------|------------------|
| **`fetch_attachment` signature** | `fetch_attachment(attachment_id, …)` — agent passes an attachment id | As-built: `fetch_attachment(ref, mimeHint?)` — `ref` is the full `downloadUrl` exposed in attachment metadata; `mimeHint` is a mime/filename hint (not an id). The connector also falls back to the download response `Content-Type` when `mimeHint` is absent or is not a `/`-delimited mime string. |
| **`tool_call_budget` config location** | Design §4 listed it under `atlassian.*` | As-built: lives under `triage.tool_call_budget` (alongside `triage.thinking_level`), because the budget is a per-pass bound across **all** tools (including `search_tasks`) — not Atlassian-specific. |
| **Timeout architecture — two layers** | Design §3.3 described a single 180s `AbortController`/`session.abort()` guard | As-built: **two independent layers** — (a) a *worker-level authoritative* `runWithTimeout(180s)` that hard-cancels the async task and records the error, and (b) an *engine-level best-effort* `session.abort()` that asks the Bedrock SDK to stop streaming. The worker-level layer is the only one covered by unit tests; the engine-level abort is a best-effort hint and is **not** unit-tested (pending SDK session injection into the engine). |
| **Prefetch detection in `ext-triage`** | Plan implied `ext-triage` would import `extractRefs` from `@tq/ext-atlassian` | As-built: the ref-extraction logic is **duplicated** inside `@tq/ext-triage` to preserve the hard isolation rule (no inter-extension imports). The two copies are kept in sync by convention; a future `@tq/text-utils` could consolidate them. |
| **Phase B mock harness gap** | Phase B used a lightweight in-memory mock `ExtensionContext`; Fastify HTTP routing was not covered | As-built: the gap was **closed in Phase C** by daemon integration tests (`packages/daemon/__tests__`) that drive real Fastify routing via `buildServer` + `app.inject` — covering static-vs-parametric route precedence, query-string parsing, and `status ?? 200` defaulting. |
| **Engine-level `session.abort()` not unit-tested** | — | As-built: `session.abort()` requires injecting the SDK session object into the engine; that injection is not yet done. The 180s-bound unit test covers only the `runWithTimeout` worker layer. Tracked as a residual gap under the risk register entry "Runaway tool loops / cost". |

---

## 0. Decision ledger (the authoritative record)

| # | Decision |
|---|---|
| **Q1** | **Two layers, both present.** (a) **Deterministic prefetch:** before the agent runs, detect Jira keys/URLs + Confluence URLs in the intake and inject their content as context. (b) **Agent-driven tools:** the LLM can still search/read Jira/Confluence on demand when prefetch misses. Prefetch is an optimization; tools are the always-available fallback. |
| **Q2** | **Pure REST client — no `acli`, no `uv`, no subprocess.** `acli`'s appeal ("already configured") doesn't survive a daemon: its OAuth isn't cleanly reusable (we'd shell out to a laptop-only binary), and Confluence *search* isn't in `acli` anyway (needs an API token + `uv` + a Python script), so `acli` gives **two** auth paths, not uniform coverage. A typed `fetch` client collapses all operations onto **one credential + one code path**, is mockable/testable, and is portable off the laptop. |
| **Q4** | **API token + Basic auth.** `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` (reuse the env-var names the `diligent-atlassian` skill documents). Token in **process env only**, never config/commit. Presence of both is the **token-gate** that registers the connector (graceful degradation, mirroring Bedrock/embedder). OAuth 3LO rejected: app registration + redirect flow + refresh storage is absurd overhead for a single-user local daemon. |
| **Q5** | **Separate `@tq/ext-atlassian` extension**, not inline in `ext-triage`. Owns the REST client + token; exposes read-only gateway endpoints under `/api/ext/atlassian/*`. `ext-triage` gets thin **injected closures** (exactly like the existing `searchTasks` → `/ext/search-semantic`) — never imports the connector. Establishes the **source-connector pattern** (gateway endpoints + injected closures + token-gated registration) for future GitHub/Glean connectors and makes Atlassian data reusable by web/CLI later. |
| **Q6** | **"Fat get + opt-in include flags"**, 4 core tools (keeps the model focused). `jira_get(ref, include?)` / `confluence_get(ref, include?)` with `include ⊆ {comments, attachments, history}` (default = lean core fields only; agent escalates). `jira_search(jql, limit)` / `confluence_search(cql, limit)` with **raw JQL/CQL** exposed. All **strictly read-only** (no create/edit/transition). `get` tools accept a **URL or a key/id** and parse the id internally. |
| **Q7** | **Attachments are a separate, explicit tool with preprocessing in the connector.** `get(...,include:["attachments"])` returns **metadata only** (id/filename/mime/size). A dedicated `fetch_attachment(ref, mimeHint?)` downloads the binary and returns a **model-ready normalized `{text?, images?}`**. (As-built: 2nd arg is a mime/filename hint, not an id; `ref` is the attachment `downloadUrl` now exposed in metadata; the connector also falls back to the download response `Content-Type`.) Preprocessing (resize, parse) lives in `ext-atlassian` so triage stays format-agnostic and every future consumer reuses it. `sharp` is duplicated into the connector (stays in `ext-triage` for user screenshots); a shared `@tq/media` util is the eventual dedup (deferred). |
| **Q8** | **v1 attachment type tiers (graceful "unsupported" otherwise):** images → resize → `ImageContent`; text/markdown/csv/json/log → text (truncated); PDF → **text extraction only** (no page-render); Office (docx/xlsx/pptx) & scanned-PDF render **deferred**. |
| **Q9** | **One rendered-HTML→Markdown shaping pipeline for both systems.** Jira `expand=renderedFields`, Confluence `body.view` → HTML → Markdown (e.g. `turndown`) → truncate to a token budget. Avoids two bespoke ADF/storage parsers; preserves headings/lists/links/tables cheaply. Lives in the connector. |
| **Q10** | **Prefetch rules:** scan `intake.body` + `intake.source_ref` for Confluence URLs, Jira URLs, **and bare Jira keys** (`\b[A-Z][A-Z0-9]+-\d+\b`, **fetch-and-drop** 404/403, biased by `atlassian.jira_projects` to cut false positives). **Lean depth**, **cap 5**, deduped, **failures swallowed** (never break the pass), **no cross-pass cache** (a retriage sees current state). |
| **Q11** | **Injection posture = delimit-and-accept.** Fetched content is wrapped as labeled *DATA, not instructions*; the **read-only tool surface** is the real boundary (no write/bash/exfiltration → worst case is a mis-triage, caught in the trace, fixed by retriage). No sanitization, no firewall LLM, no space allow-listing. Revisit hard if triage ever gains write powers. |
| **Q12** | **Three independent bounds (config-tunable):** per-request **15s** + response-size caps; per-pass **30** tool-call budget (then tools return "call `emit_triage` now"); per-pass wall-clock **180s** via `AbortController`/`session.abort()` → existing failure path (persist trace+error, leave intake `new` for retriage). |
| **Q13** | **Config split:** creds in **env only** (`ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN`); `atlassian.base_url` (default `https://diligentbrands.atlassian.net`), `atlassian.jira_projects` (bare-key filter), `triage.thinking_level`, and the Q12 bounds in `tq` config. |
| **Q14** | **Prompt is parameterized:** `buildTriagePrompt(labelVocabulary, { atlassianEnabled })` — Atlassian section omitted when the gate is off (never advertise absent tools). Section teaches escalation discipline, "don't re-fetch prefetched refs", the data-not-instructions caution, and the read-only reminder. **`thinkingLevel: "low"`** (was `off`), tunable via config. |
| **Q15** | **Tests = hand-written `fetch` mocks** (client, HTML→MD shaping, attachment tiers), detection/prefetch units, gateway-endpoint tests via the in-memory extension-host harness, engine tests for prefetch-injection + budget. **No live API in CI**; one opt-in manual smoke script gated on `ATLASSIAN_API_TOKEN`. Recorded fixtures deferred until tested on real data. |
| **Q16** | **Trace visibility, zero web change:** prefetch is emitted as **synthetic `tool_call`/`tool_result`** steps (`tool: "prefetch"`); `fetch_attachment` images are **text-summarized** in the trace (real `ImageContent` still reaches the model). Dashboard renders tool steps generically already. |

---

## 1. Architecture

```
            ┌──────────────────────── task daemon (single Node process) ─────────────────────────┐
            │                                                                                     │
            │   CORE (authoritative) ── events ──►  extension host                                │
            │        ▲  REST + context                     │                                      │
            │        │                                      │                                     │
            │  ┌─────┴───────────── @tq/ext-triage ─────────┴──┐   ┌──── @tq/ext-atlassian ────┐  │
            │  │ on IntakeCaptured/Retriaged                    │   │ REST client (fetch, Basic) │ │
            │  │  • PiTriageEngine (Bedrock, thinking:low)      │   │ gateway, read-only:        │ │
            │  │  • prefetch refs ──────────────┐               │   │  /jira/{key}               │ │
            │  │  • inject closures as LLM tools │  core.request │   │  /jira/search              │ │
            │  │      jira_get / jira_search ────┼──────────────►│──►│  /confluence/{id}          │ │
            │  │      confluence_get / _search   │   /api/ext/   │   │  /confluence/search        │ │
            │  │      fetch_attachment ──────────┘   atlassian/* │   │  /attachment               │ │
            │  │  • emit_triage (structured out)                │   │ shaping: HTML→Markdown     │ │
            │  └────────────────────────────────────────────────┘   │ attach preprocess (sharp) │ │
            │                                                        └────────────▲──────────────┘ │
            │   token-gate: registers only if ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN ┘              │
            └─────────────────────────────────────────────────────────────────────────────────────┘
                                                  │ HTTPS Basic auth
                                                  ▼
                                   diligentbrands.atlassian.net  (Jira + Confluence Cloud REST)
```

**Why a separate extension (Q5).** It mirrors the established `searchTasks → /ext/search-semantic`
precedent: a capability lives in one extension behind the gateway, and the triage engine receives
thin injected closures. This preserves the hard isolation rule (no inter-extension imports),
puts token ownership + degradation in one place, and makes Atlassian reads reusable beyond triage
(a future web task-detail "live Jira status", a CLI link dereference) without re-plumbing creds.

---

## 2. The connector: `@tq/ext-atlassian`

### 2.1 REST client (Q2, Q4)
- Single `fetch`-based client, Basic auth header `base64(email:token)`, `base_url` from config.
- Endpoints used:
  - Jira issue: `GET /rest/api/3/issue/{key}?expand=renderedFields[,changelog]`
  - Jira search: `POST /rest/api/3/search/jql` (JQL in body)
  - Confluence page: `GET /wiki/api/v2/pages/{id}?body-format=view` (+ children/labels/versions as needed)
  - Confluence search: `GET /wiki/rest/api/search?cql=…`
  - Attachment bytes: the attachment's `content`/download URL (same Basic auth).
- Per-request timeout **15s** (`AbortSignal.timeout`), response sizes capped, errors normalized to a
  small `{ ok:false, status, message }` shape the closures turn into tool error text.

### 2.2 Gateway endpoints (Q5, Q7) — all read-only
| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/ext/atlassian/jira/{key}?include=comments,attachments,history` | normalized issue |
| `GET` | `/api/ext/atlassian/jira/search?jql=…&limit=` | `{ hits: [{key,summary,status}] }` |
| `GET` | `/api/ext/atlassian/confluence/{id}?include=…` | normalized page |
| `GET` | `/api/ext/atlassian/confluence/search?cql=…&limit=` | `{ hits: [{id,title,space,url}] }` |
| `GET` | `/api/ext/atlassian/attachment?ref=…&id=…` | `{ text?, images?: [{mime,dataBase64}] }` |

Normalized issue/page shape (model-ready):
```jsonc
{
  "ref": "AIBM3-56",
  "url": "https://…/browse/AIBM3-56",
  "title": "…",            // summary / page title
  "status": "In Progress", // jira only
  "type": "Bug",           // jira only
  "labels": ["…"],
  "bodyMarkdown": "…",     // rendered HTML → markdown, truncated (Q9)
  "comments": [{ "author": "…", "when": "…", "bodyMarkdown": "…" }],   // include=comments
  "attachments": [{ "id": "…", "filename": "…", "mime": "…", "size": 1234 }], // metadata only (Q7)
  "history": [{ "author": "…", "when": "…", "summary": "field X: a→b" }]       // include=history, ~last 10
}
```

### 2.3 Content shaping (Q9)
`renderedFields` (Jira) / `body.view` (Confluence) → HTML → Markdown (`turndown` w/ scripts/styles
stripped) → truncate to a token budget. **One** converter serves both systems.

### 2.4 Attachment preprocessing (Q7, Q8)
`fetch_attachment` downloads bytes (size-capped) and branches on mime:
- `image/*` → `prepareImageForTriage`-style resize (1568px long-edge) → `ImageContent`.
- text/markdown/csv/json/log → UTF-8 text, truncated.
- `application/pdf` → text extraction (`pdf-parse`/`pdfjs`); empty text → metadata + "no extractable text".
- everything else → metadata + "unsupported type in v1".
Returns `{ text?, images? }` over the gateway (images base64); the triage closure maps these into the
tool result `content` blocks.

---

## 3. Triage integration: `@tq/ext-triage` changes

### 3.1 Injected closures + tools (Q5, Q6)
`handleIntake` builds closures (capturing `ctx.core`) that call the gateway endpoints and fall back to
clean tool-error text on failure. `PiTriageEngine` registers them as `defineTool`s: `jira_get`,
`jira_search`, `confluence_get`, `confluence_search`, `fetch_attachment` — alongside the existing
`search_tasks`/`emit_triage`. Tools registered **only** when the connector is hosted (probe via a
gateway `GET /api/ext/atlassian/health` or `ctx.core.request` returning 404 → disabled).

### 3.2 Prefetch (Q10, Q16)
In the engine, before `session.prompt`:
1. Extract candidate refs from `intake.body` + `intake.source_ref` (Confluence/Jira URLs + bare keys).
2. Filter bare keys by `atlassian.jira_projects`; dedupe; cap 5.
3. Call the **lean** `jira_get`/`confluence_get` closures; swallow failures.
4. Prepend a delimited **"## Referenced context"** block (Q11 framing) to the user prompt.
5. Emit synthetic `prefetch` trace steps for dashboard visibility.

### 3.3 Bounds (Q12)
- Connector enforces the 15s per-request timeout.
- Engine wraps each Atlassian/search closure with a **call counter**; past 30, the closure returns
  *"search budget exhausted — call emit_triage now with your best assessment."*
- Engine arms an `AbortController` at 180s; on trip, the existing `catch` path persists trace+error
  and leaves the intake `new` (retriage re-runs).

### 3.4 Prompt + model (Q14)
`buildTriagePrompt(labelVocabulary, { atlassianEnabled })`; Atlassian section conditional.
`thinkingLevel` from `config.triage.thinking_level` (default `"low"`).

---

## 4. Configuration (Q13)

```jsonc
// tq config
{
  "atlassian": {
    "base_url": "https://diligentbrands.atlassian.net",
    "jira_projects": ["AIBM3", "AIBM"],     // bare-key prefetch filter; [] = fetch-and-drop all
    "request_timeout_ms": 15000,
    "pass_timeout_ms": 180000,
    "prefetch_max": 5,
    "body_markdown_max_chars": 8000,
    "attachment_max_bytes": 26214400          // 25 MiB
  },
  "triage": { "thinking_level": "low", "tool_call_budget": 30 /* as-built: total per-pass tool budget (incl. search_tasks); moved here from atlassian.* */ }
}
// env (never committed): ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN
```

The connector registers iff `ATLASSIAN_EMAIL` **and** `ATLASSIAN_API_TOKEN` are present; otherwise the
daemon logs `[tq] atlassian connector disabled (no creds)` and triage runs without Atlassian tools.

---

## 5. Security & failure posture (Q11, Q12)

- **Read-only** is the security boundary; tools cannot write, run shell, or exfiltrate.
- Fetched content is delimited as data; the prompt forbids following instructions inside it.
- Every external call fails **safe**: prefetch failures are swallowed; tool failures return error text
  the agent can react to; a stalled pass is aborted at 180s and retried via the existing path.
- Token is env-only; never logged, never persisted to context/trace.

---

## 6. Deferred (explicit)

- Shared `@tq/media` util to dedup `sharp` across `ext-triage`/`ext-atlassian`.
- Office (docx/xlsx/pptx) + scanned-PDF page-render attachment support.
- Dashboard rendering of fetched attachment images (currently text-summarized).
- A generic **connector contract**/SDK abstraction — extract when the *second* connector (GitHub/Glean)
  lands; build this one concretely first.
- Cross-pass caching of fetched refs (deliberately omitted so retriage sees current state).
- Confluence CQL short-link (`/wiki/x/…`) resolution in prefetch.
```
