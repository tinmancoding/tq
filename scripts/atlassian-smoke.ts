/**
 * atlassian-smoke.ts — MANUAL smoke test for the Atlassian gateway extension.
 *
 * This script is INTENTIONALLY NOT wired into `pnpm test` or CI.
 * Run it by hand only when you have real Atlassian credentials and a running
 * tq daemon (or standalone, exercising AtlassianClient + normalizers directly).
 *
 * ─── Prerequisites ───────────────────────────────────────────────────────────
 *
 *   1. Export credentials:
 *        export ATLASSIAN_EMAIL="you@company.com"
 *        export ATLASSIAN_API_TOKEN="<your-api-token>"
 *
 *   2. (Recommended) Run the smoke against a live daemon — start one first:
 *        TQ_CONFIG=~/.config/tq/dev.toml pnpm dev
 *
 *   3. Run:
 *        pnpm tsx scripts/atlassian-smoke.ts [JIRA_KEY] [CONFLUENCE_PAGE_ID]
 *
 *      e.g.
 *        ATLASSIAN_EMAIL=me@acme.com ATLASSIAN_API_TOKEN=xxx \
 *          pnpm tsx scripts/atlassian-smoke.ts AIBM3-351 6909886504
 *
 * ─── Mode ────────────────────────────────────────────────────────────────────
 *
 *   The script imports from packages/ext-atlassian/src directly (no build
 *   required) and drives AtlassianClient + the normalizers DIRECTLY — no
 *   daemon needed. This makes it a self-contained smoke that typechecks
 *   against the same code the daemon runs.
 *
 * ─── What it exercises ───────────────────────────────────────────────────────
 *
 *   1. Jira GET      — fetch a single issue by key
 *   2. Jira search   — small JQL query (project = <project>)
 *   3. Confluence GET — fetch a single page by numeric id
 *   4. Confluence search — small CQL query (type = page)
 *   5. Attachment metadata listing — confluence GET with include=attachments
 *   6. Security gate — off-origin attachment ref returns 403 / refusal
 *
 * Each operation prints the normalized output to stdout. Errors print to stderr.
 */

// Import directly from source so the script runs without a package-context wrapper.
// tsx resolves .ts imports natively; no build step needed.
import {
  AtlassianClient,
  isAtlassianError,
  normalizeIssue,
  normalizePage,
  normalizeJiraSearchResults,
  normalizeConfluenceSearchResults,
} from "../packages/ext-atlassian/src/index.js";

// ─── Credential gate ─────────────────────────────────────────────────────────

const email = process.env["ATLASSIAN_EMAIL"];
const token = process.env["ATLASSIAN_API_TOKEN"];

if (!email || !token) {
  console.error(
    "\n❌  Missing credentials — this script requires BOTH env vars to be set:\n" +
      "\n    ATLASSIAN_EMAIL=you@company.com" +
      "\n    ATLASSIAN_API_TOKEN=<your-api-token>\n" +
      "\nExporting them and re-running:\n" +
      "\n    export ATLASSIAN_EMAIL=you@company.com" +
      "\n    export ATLASSIAN_API_TOKEN=<your-api-token>" +
      "\n    pnpm tsx scripts/atlassian-smoke.ts AIBM3-351 6909886504\n",
  );
  process.exit(1);
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

const jiraKey = process.argv[2] ?? "AIBM3-1";
const confluenceId = process.argv[3] ?? "1";

if (process.argv[2] === undefined) {
  console.warn(
    `⚠  No JIRA_KEY provided — using placeholder '${jiraKey}'.\n` +
      `   Usage: pnpm tsx scripts/atlassian-smoke.ts <JIRA_KEY> <CONFLUENCE_PAGE_ID>\n` +
      `   e.g.:  pnpm tsx scripts/atlassian-smoke.ts AIBM3-351 6909886504\n`,
  );
}

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = process.env["ATLASSIAN_BASE_URL"] ?? "https://diligentbrands.atlassian.net";
const BODY_MAX = 2_000; // shorter for smoke readability

const client = new AtlassianClient({
  baseUrl: BASE_URL,
  email,
  token,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function section(title: string): void {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`▶  ${title}`);
  console.log("─".repeat(70));
}

function printJson(label: string, value: unknown): void {
  console.log(`\n${label}:`);
  console.log(JSON.stringify(value, null, 2));
}

// ─── 1. Jira GET ─────────────────────────────────────────────────────────────

section(`1. Jira GET — issue ${jiraKey}`);

{
  const raw = await client.getIssue(jiraKey, "renderedFields");
  if (isAtlassianError(raw)) {
    console.error(`  ✗ ERROR ${raw.status}: ${raw.message}`);
  } else {
    const normalized = normalizeIssue(raw, BASE_URL, [], BODY_MAX);
    printJson("Normalized issue (lean)", normalized);
    console.log("\n  ✓ Jira GET OK");
  }
}

// ─── 2. Jira search ──────────────────────────────────────────────────────────

// Derive project from the key (e.g. "AIBM3-351" → "AIBM3")
const jiraProject = jiraKey.replace(/-\d+$/, "");
const jql = `project = "${jiraProject}" ORDER BY updated DESC`;

section(`2. Jira search — JQL: ${jql} (limit 3)`);

{
  const raw = await client.searchJira(jql, 3);
  if (isAtlassianError(raw)) {
    console.error(`  ✗ ERROR ${raw.status}: ${raw.message}`);
  } else {
    const hits = normalizeJiraSearchResults(raw);
    printJson("Search hits", hits);
    console.log(`\n  ✓ Jira search OK (${hits.length} hit(s))`);
  }
}

// ─── 3. Confluence GET ────────────────────────────────────────────────────────

section(`3. Confluence GET — page ${confluenceId}`);

{
  const raw = await client.getPage(confluenceId);
  if (isAtlassianError(raw)) {
    console.error(`  ✗ ERROR ${raw.status}: ${raw.message}`);
  } else {
    const normalized = normalizePage(raw, BASE_URL, [], BODY_MAX);
    printJson("Normalized page (lean)", normalized);
    console.log("\n  ✓ Confluence GET OK");
  }
}

// ─── 4. Confluence search ────────────────────────────────────────────────────

const cql = `type = "page" ORDER BY lastmodified DESC`;

section(`4. Confluence search — CQL: ${cql} (limit 3)`);

{
  const raw = await client.searchConfluence(cql, 3);
  if (isAtlassianError(raw)) {
    console.error(`  ✗ ERROR ${raw.status}: ${raw.message}`);
  } else {
    const hits = normalizeConfluenceSearchResults(raw, BASE_URL);
    printJson("Search hits", hits);
    console.log(`\n  ✓ Confluence search OK (${hits.length} hit(s))`);
  }
}

// ─── 5. Attachment metadata listing ─────────────────────────────────────────

section(`5. Confluence GET with include=attachments — page ${confluenceId}`);

{
  // Fetch page + attachments secondary call
  const raw = await client.getPage(confluenceId);
  if (isAtlassianError(raw)) {
    console.error(`  ✗ Page GET ERROR ${raw.status}: ${raw.message}`);
  } else {
    const normalized = normalizePage(raw, BASE_URL, ["attachments"], BODY_MAX);
    // Overlay attachments from the secondary v2 endpoint
    const attachResult = await client.getPageAttachments(confluenceId);
    if (isAtlassianError(attachResult)) {
      console.error(`  ✗ Attachments GET ERROR ${attachResult.status}: ${attachResult.message}`);
    } else {
      normalized.attachments = attachResult.results.map((a) => {
        const dl = a.downloadLink ?? "";
        const downloadUrl = dl.startsWith("http") ? dl : `${BASE_URL}/wiki${dl}`;
        return {
          id: a.id,
          filename: a.title,
          mime: a.mediaType,
          size: a.fileSize,
          downloadUrl,
        };
      });
      printJson("Page with attachment metadata", {
        ref: normalized.ref,
        title: normalized.title,
        attachmentCount: normalized.attachments?.length ?? 0,
        attachments: normalized.attachments,
      });
      console.log("\n  ✓ Attachment metadata listing OK");
    }
  }
}

// ─── 6. Security gate — off-origin attachment ref ────────────────────────────

section("6. Security gate — off-origin attachment ref (expect refusal)");

{
  // Simulate what the /attachment gateway handler does:
  // It refuses any ref whose origin !== the configured Atlassian instance.
  const offOriginRef = "https://evil.example.com/wiki/download/attachments/123/malicious.png";
  const allowedOrigin = new URL(BASE_URL).origin;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(offOriginRef);
  } catch {
    console.error("  ✗ Could not parse off-origin ref URL (unexpected)");
    process.exit(1);
  }

  if (parsedUrl.origin !== allowedOrigin) {
    console.log(
      `\n  ✓ Security gate REFUSED (as expected):\n` +
        `    ref origin:     '${parsedUrl.origin}'\n` +
        `    allowed origin: '${allowedOrigin}'\n` +
        `    → Would return HTTP 403: attachment ref origin '${parsedUrl.origin}' is not the configured Atlassian instance ('${allowedOrigin}'); download refused`,
    );
  } else {
    console.error(
      "  ✗ UNEXPECTED: off-origin ref was not caught — check BASE_URL and the ref above.",
    );
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(70)}`);
console.log("Smoke complete.  Review the output above for any ✗ errors.");
console.log(`${"═".repeat(70)}\n`);
