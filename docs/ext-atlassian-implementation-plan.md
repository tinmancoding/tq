# `@tq/ext-atlassian` + Triage Enrichment — Implementation Plan

> Companion to [`ext-atlassian-design.md`](ext-atlassian-design.md) (the *what/why* and the Q1–Q16
> decision ledger). This doc is the *how*: ordered phases, concrete file touchpoints, tests, and
> acceptance gates. Style follows `event-driven-implementation-plan.md`.
>
> **Operational discipline (AGENTS.md), every phase:**
> - Develop against a **throwaway `TQ_CONFIG` profile** — the default DB is real data.
> - The daemon runs under `tsx` with **no watch** → **hand-restart it** after any change to
>   `core`, `daemon`, `ext-triage`, `ext-atlassian`, `extension-sdk`, or `contract`.
> - **Never commit credentials.** `ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN` live in your shell env.
> - Each phase ends **green** (`pnpm test` + `pnpm typecheck`) and the app still works end-to-end.
>
> **Status: NOT STARTED.**

---

## 0. Conventions up front

- **Isolation (hard rule):** `ext-atlassian` never imports `@tq/core`; `ext-triage` never imports
  `@tq/ext-atlassian`. All cross-extension traffic goes over the gateway via `ctx.core.request`.
- **Token-gate:** the connector registers only when both env creds are present. Triage degrades
  gracefully (no Atlassian tools, no prefetch, Atlassian-less prompt) when absent.
- **Read-only:** every endpoint and tool is a GET/read. No create/edit/transition, ever.
- **Fail safe:** prefetch swallows errors; tools return error text; the pass aborts at the wall-clock
  bound into the existing retriage path.
- **No live API in CI:** unit tests mock `fetch`; one opt-in manual smoke script hits the real API.

---

## 1. Phase A — `@tq/ext-atlassian` skeleton + REST client (offline)

**Goal:** a typed, tested REST client + shaping, with zero daemon wiring yet.

**Touchpoints**
- `packages/ext-atlassian/package.json` — deps: `@tq/contract`, `@tq/extension-sdk`,
  `@sinclair/typebox`, `turndown`, `sharp`, a PDF text lib (`pdf-parse` or `pdfjs-dist`).
- `src/client.ts` — `AtlassianClient` (Basic auth, `base_url`, 15s `AbortSignal.timeout`,
  normalized error shape). Methods: `getIssue`, `searchJira`, `getPage`, `searchConfluence`,
  `getAttachmentBytes`.
- `src/shape.ts` — `htmlToMarkdown()` (turndown, strip script/style), `truncate()`.
- `src/normalize.ts` — map raw Jira/Confluence payloads → the normalized issue/page shape
  (`design §2.2`), honoring `include` flags.
- `src/attachment.ts` — `preprocessAttachment(bytes, mime)` → `{ text?, images? }` (Q8 tiers;
  reuse the 1568px resize logic).
- `src/refs.ts` — `parseRef()` (URL **or** key/id → `{kind, key|id}`), `extractRefs(text)` for prefetch.

**Tests (mocked `fetch`)**
- `client.test.ts` — request shaping (auth header, expand params), timeout, error normalization.
- `shape.test.ts` — HTML→Markdown for headings/lists/links/tables; truncation.
- `attachment.test.ts` — image resize, text passthrough, PDF→text, unsupported note.
- `refs.test.ts` — URL/key/id parsing; `extractRefs` finds URLs + bare keys; bare-key project filter;
  dedupe; cap.

**Gate:** `pnpm --filter @tq/ext-atlassian test typecheck` green. No daemon changes.

---

## 2. Phase B — Extension definition + gateway endpoints

**Goal:** `ext-atlassian` is a real `defineExtension` exposing the read-only gateway surface.

**Touchpoints**
- `src/extension.ts` — `atlassianExtension({ client, config })`; registers the 5 routes
  (`design §2.2`) under the host's `/api/ext/atlassian/*` mount; a `health` route for the triage probe.
- `src/index.ts` — public exports (`atlassianExtension`, `AtlassianClient`, types).
- Reuse the in-memory extension-host harness used by `triage-extension.test.ts`.

**Tests**
- `extension.test.ts` — each endpoint returns the normalized shape; `include` flags toggle
  comments/attachments/history; bad ref → 4xx with normalized error; `/attachment` returns
  `{text,images}`.

**Gate:** endpoints answer through the package's mock-context harness; isolation check (no
`@tq/core` import) holds across all `src/` files.

> **As-built note (Phase B):** the package suite uses a lightweight mock `ExtensionContext` that
> dispatches to handlers by registered route key. It validates handler logic (include-flag wiring,
> secondary v2 calls, error→status mapping, attachment preprocessing) but **bypasses Fastify
> routing** — so static-vs-parametric precedence (`/jira/search` vs `/jira/:key`), the
> `/api/ext/atlassian/*` mount prefix, query-string parsing, and `res.status ?? 200` defaulting are
> **not** covered here. A package-local integration test can't fix this without importing
> `@tq/core`/the daemon (which would break isolation), so the real gateway integration test is
> **deferred to Phase C** (see below). Two real-daemon gaps the mocks structurally hid were caught in
> review and fixed in Phase B: `/attachment` now host-gates the Basic-auth credential to the
> `base_url` origin, and `getPageFooterComments` requests `?body-format=view`.

---

## 3. Phase C — Daemon wiring + token-gate

**Goal:** the connector is hosted by the daemon when creds exist; disabled cleanly otherwise.

**Touchpoints**
- `packages/core` config schema — add the `atlassian` block (`design §4`) + `triage.thinking_level`.
- `packages/daemon/src/main.ts` — read `ATLASSIAN_EMAIL`/`ATLASSIAN_API_TOKEN` from env; if both
  present, construct `AtlassianClient` + `atlassianExtension(...)` and add to `extensions`; log
  enabled/disabled like the triage/embedder probes.

**Tests**
- Config parse test (defaults + overrides).
- Daemon boot test: creds present → route reachable; creds absent → 404 + disabled log.
- **Gateway integration test (closes the Phase B harness gap)** in `packages/daemon/__tests__`,
  via `buildServer` + `app.inject` through real HTTP routing: hit `/api/ext/atlassian/jira/:key`,
  `/jira/search`, `/confluence/:id`, `/confluence/search`, `/attachment`; assert status mapping and
  that `/jira/search` & `/confluence/search` are **not** shadowed by the parametric `:key`/`:id`
  routes. Mock the `AtlassianClient` so no live network is needed.

**Manual:** restart daemon against throwaway profile; `curl /api/ext/atlassian/jira/<realkey>` with
real env creds returns a normalized issue. (Per `docs/local_development.md`.)

**Gate:** green; live `curl` smoke passes.

---

## 4. Phase D — Triage tools (agent-driven path)

**Goal:** the triage agent can search/read Jira & Confluence on demand.

**Touchpoints**
- `packages/ext-triage/src/extension.ts` — build injected closures (capturing `ctx.core`) for the 5
  operations, each calling `/api/ext/atlassian/*`, returning clean tool-error text on failure;
  probe the connector (`/health`) → `atlassianEnabled`.
- `src/pi-engine.ts` — accept the closures + `atlassianEnabled`; register `defineTool`s for
  `jira_get`, `jira_search`, `confluence_get`, `confluence_search`, `fetch_attachment`
  (typed params; `fetch_attachment`/`*_get` map normalized `{text,images}` → tool `content`);
  wrap closures with the **30-call budget** counter; set `thinkingLevel` from config.
- `src/prompt.ts` — `buildTriagePrompt(labelVocabulary, { atlassianEnabled })`; Atlassian section
  (tools, escalation discipline, data-not-instructions caution, read-only reminder).

**Tests**
- Engine test (fake closures): tools registered only when enabled; budget message fires at 30;
  `fetch_attachment` image mapping produces `ImageContent`.
- Prompt test: section present/absent by flag.
- Extend `triage-extension.test.ts` mock-engine path stays green.

**Gate:** green; manual retriage of a real intake shows the agent calling `jira_get`/`confluence_get`
in the dashboard trace.

---

## 5. Phase E — Prefetch (always-on path) + wall-clock bound

**Goal:** referenced links/keys are dereferenced and injected before the agent runs.

**Touchpoints**
- `src/pi-engine.ts` — before `session.prompt`: `extractRefs(body + source_ref)` → filter/dedupe/cap 5
  → call lean `*_get` closures (swallow failures) → prepend delimited **"## Referenced context"**
  block → emit synthetic `prefetch` `tool_call`/`tool_result` trace steps (Q16). Arm the **180s**
  `AbortController`; on trip reuse the existing `catch` path.

**Tests**
- Prefetch unit: refs extracted/filtered/capped; prompt contains the referenced block; a failing
  closure does **not** throw; synthetic trace steps emitted.
- Abort test: a hung closure trips the 180s guard → intake stays `new`, error persisted.

**Gate:** green; manual intake containing a real Jira key + Confluence URL shows a populated
"Referenced context" + `prefetch` trace steps; the agent does **not** re-fetch what was prefetched.

---

## 6. Phase F — Polish, docs, smoke script

**Touchpoints**
- `scripts/atlassian-smoke.ts` — opt-in, gated on `ATLASSIAN_API_TOKEN`; exercises each endpoint
  against the real instance and prints normalized output (manual, not CI).
- `packages/ext-atlassian/README.md` — setup (env vars, config), endpoint reference, the
  source-connector pattern note for future connectors.
- Update `docs/ext-atlassian-design.md` status → **implemented**; record any as-built deviations
  (ledger-style) and the commit SHAs per phase.
- `docs/local_development.md` — add the "enable Atlassian connector" recipe (env vars + restart).

**Gate:** full `pnpm test` + `pnpm typecheck` green; live smoke script passes; dashboard end-to-end
verified (prefetch + on-demand tools + attachment fetch) per `docs/local_development.md`.

---

## 7. Risk register

| Risk | Mitigation |
|---|---|
| `renderedFields`/`body.view` HTML noise bloats tokens | turndown strip + `body_markdown_max_chars` truncation; tune in config |
| Bare-key false positives waste API calls | `jira_projects` prefix filter + fetch-and-drop 404s; cap 5 |
| Prompt injection from fetched content | read-only surface (the real boundary) + delimit-as-data prompt (Q11) |
| Runaway tool loops / cost | 15s/30-call/180s bounds (Q12), all fail-safe |
| `sharp`/PDF native deps duplicated | accepted now; future `@tq/media` util (deferred) |
| API token leakage | env-only, never logged/persisted; token-gated registration |
| Confluence CQL needs token while Jira/page use same token | single token covers all (pure-REST decision, Q2) — no split |

---

## 8. Sequencing summary

```
A client+shaping (offline, mocked)  →  B extension+gateway endpoints  →  C daemon wiring+token-gate
   →  D agent tools (on-demand)  →  E prefetch + wall-clock bound  →  F polish/docs/smoke
```

Each phase is independently green and leaves `tq` working. A–C ship a reusable Atlassian read API even
before triage touches it; D–E layer triage enrichment on top; F hardens and documents.
