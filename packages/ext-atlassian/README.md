# `@tq/ext-atlassian`

Read-only Atlassian (Jira + Confluence Cloud) gateway extension for `tq`.
Exposes a set of REST endpoints under `/api/ext/atlassian/*` that the triage
extension and future connectors can call. Never imports `@tq/core` — all
cross-extension traffic goes over the public REST gateway.

---

## Setup

### 1. Credentials (env vars — never in config files)

```bash
export ATLASSIAN_EMAIL="you@company.com"
export ATLASSIAN_API_TOKEN="<your Atlassian API token>"
```

Generate an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.

The connector **only registers** when both variables are present. When either is missing
the daemon logs `[tq] atlassian connector disabled (no creds)` and the triage extension
runs without Atlassian tools (graceful degradation).

> **Never put credentials in `config.toml`.** They are env-only by design (Q4 in the
> decision ledger). Nothing in the codebase persists or logs them.

### 2. Config block (`~/.config/tq/config.toml`)

```toml
[atlassian]
# Atlassian Cloud base URL — no trailing slash.
base_url = "https://diligentbrands.atlassian.net"

# Bare Jira-key project prefixes used to filter prefetch candidates
# (e.g. AIBM3-351 matches because "AIBM3" is in this list).
# Set to [] to disable the filter (fetch-and-drop 404s instead).
jira_projects = ["AIBM3", "AIBM"]

# Optional overrides (defaults shown):
# request_timeout_ms = 15000    # per-request HTTP timeout
# pass_timeout_ms = 180000      # wall-clock bound for an entire triage pass
# prefetch_max = 5              # max refs auto-dereferenced before the agent runs
# body_markdown_max_chars = 8000
# attachment_max_bytes = 26214400   # 25 MiB

[triage]
# thinking_level controls Claude's extended-thinking budget.
# "low" (default) | "medium" | "high" | "off"
thinking_level = "low"

# Maximum number of tool calls the agent may make in a single triage pass
# (across all tools including search_tasks, jira_get, etc.).
# When the budget is exhausted the next tool call returns an instruction to
# emit_triage immediately with the best available assessment.
tool_call_budget = 30
```

---

## Endpoint reference (all read-only)

The daemon mounts these under `/api/ext/atlassian/` when the connector is enabled.

| Method | Path | Query params | Returns |
|--------|------|-------------|---------|
| `GET` | `/api/ext/atlassian/health` | — | `{ ok: true, connector: "atlassian" }` |
| `GET` | `/api/ext/atlassian/jira/:key` | `include=comments,attachments,history` | Normalized issue (see shape below) |
| `GET` | `/api/ext/atlassian/jira/search` | `jql=…`, `limit=10` | `{ hits: [{ key, summary, status, type }] }` |
| `GET` | `/api/ext/atlassian/confluence/:id` | `include=comments,attachments,history,labels` | Normalized page (see shape below) |
| `GET` | `/api/ext/atlassian/confluence/search` | `cql=…`, `limit=10` | `{ hits: [{ id, title, space, url }] }` |
| `GET` | `/api/ext/atlassian/attachment` | `ref=<downloadUrl>`, `mimeHint=<mime-or-filename>` | `{ text?, images?: [{ mime, dataBase64 }] }` |

All endpoints return `{ error: "…" }` with an appropriate HTTP status code on failure.

### Normalized issue shape

```jsonc
{
  "ref": "AIBM3-56",
  "url": "https://diligentbrands.atlassian.net/browse/AIBM3-56",
  "title": "Short summary",
  "status": "In Progress",
  "type": "Bug",
  "labels": ["backend"],
  "bodyMarkdown": "…rendered body, truncated to body_markdown_max_chars…",
  // present when include=comments:
  "comments": [{ "author": "Alice", "when": "2024-01-15T10:00:00Z", "bodyMarkdown": "…" }],
  // present when include=attachments (metadata only — use /attachment to fetch bytes):
  "attachments": [{ "id": "att-1", "filename": "spec.pdf", "mime": "application/pdf", "size": 12345, "downloadUrl": "https://…" }],
  // present when include=history (last ~10 changelog entries):
  "history": [{ "author": "Bob", "when": "2024-01-14T09:00:00Z", "summary": "status: Open → In Progress" }]
}
```

### Normalized page shape

Same structure but without `status`/`type`. `labels` comes from the v2 labels endpoint
(requires `include=labels`).

### `/attachment` security gate

The `/attachment` endpoint enforces that the `ref` URL's origin matches the configured
`base_url` origin. Any attempt to pass an off-origin URL is refused with HTTP 403. This
prevents the Basic-auth credential from being forwarded to arbitrary hosts.

---

## Triage tools backed by these endpoints

`@tq/ext-triage` registers the following LLM tools that call the above endpoints
via injected closures (never importing this package directly):

| Tool | Gateway call | Purpose |
|------|-------------|---------|
| `jira_get` | `GET /jira/:key?include=…` | Fetch a full Jira issue |
| `jira_search` | `GET /jira/search?jql=…` | Search Jira with JQL |
| `confluence_get` | `GET /confluence/:id?include=…` | Fetch a full Confluence page |
| `confluence_search` | `GET /confluence/search?cql=…` | Search Confluence with CQL |
| `fetch_attachment` | `GET /attachment?ref=…&mimeHint=…` | Download + preprocess attachment bytes |

Tools are registered **only** when the connector is enabled (health probe returns 200).
When disabled, the triage prompt's Atlassian section is omitted and no Atlassian tools
are offered to the model.

Additionally, **prefetch** automatically dereferences up to 5 Jira keys / Confluence URLs
found in the intake body + `source_ref` _before_ the agent runs, injecting a
`## Referenced context` block into the prompt (emitted as synthetic `prefetch` tool steps
in the trace for dashboard visibility).

---

## Source-connector pattern

`@tq/ext-atlassian` is the **first source-connector**. A future GitHub, Glean, or other
connector would mirror the same pattern:

1. **Gateway endpoints** — `defineExtension` in its own package, exposing read-only REST
   routes under `/api/ext/<name>/*`. No imports of `@tq/core`.

2. **Injected closures** — `@tq/ext-triage` receives thin closures
   (`ctx.core.request(...)`) for each operation, mirroring `searchTasks` for semantic
   search. The triage engine never imports the connector package.

3. **Token-gated registration** — the daemon checks env credentials at startup and adds
   the extension only when they are present, logging a clear disabled message otherwise.
   The triage extension probes `/health` to detect availability and omits the
   corresponding tools/prompt-section when absent.

4. **Prefetch** — for connectors that surface dereferenceable references in intake text
   (issue keys, PR URLs), the same lean-get + swallow-failures + cap-5 pattern applies.

When a second connector (GitHub/Glean) arrives, the common shape becomes clear enough to
extract into a formal `@tq/extension-sdk` connector contract. Build this one concretely
first (per design §6 "Deferred").
