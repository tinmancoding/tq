/**
 * prefetch.ts — Deterministic Atlassian ref detection for the triage prefetch path.
 *
 * Scans free text for Jira/Confluence references so they can be fetched before
 * the agent runs. This is a PURE FUNCTION module — it does NOT import
 * @tq/ext-atlassian (cross-extension imports are forbidden by the architecture).
 * The regex patterns are intentionally similar to (but independent of) those in
 * ext-atlassian/src/refs.ts; the minor overlap is accepted per the design brief.
 *
 * @see design §3.2, Q10, Q15
 */

/** A detected reference ready to be passed to the jira_get / confluence_get closures. */
export interface PrefetchRef {
  /** "jira" → ref is the issue key (e.g. "PROJ-123").
   *  "confluence" → ref is the numeric page ID (e.g. "12345678"). */
  kind: "jira" | "confluence";
  /** Value passed directly to the jira_get / confluence_get closure. */
  ref: string;
}

export interface DetectRefsOptions {
  /**
   * If non-empty, bare Jira keys are filtered to only those whose project
   * prefix appears in this list. URL-sourced Jira keys bypass the filter.
   * Empty array (default) = keep all bare keys.
   */
  jiraProjects?: string[];
  /** Maximum refs to return (default 5, per config.atlassian.prefetch_max). */
  max?: number;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Jira issue URL — matches e.g.:
 *   https://host/browse/PROJ-123
 *   https://host/jira/browse/PROJ-123
 *   https://host/issues/PROJ-123          (some Jira paths)
 *
 * Capture group 1 = the issue key.
 *
 * NOTE: intentional divergence from ext-atlassian/refs.ts — that module only
 * matches `/browse/`; this also matches `/issues/` to be more permissive for
 * triage prefetch. Do not 'fix' this to match unless both modules are updated.
 */
const JIRA_URL_RE =
  /https?:\/\/[^/\s]+(?:\/jira)?\/(?:browse|issues)\/([A-Z][A-Z0-9]+-\d+)(?:[?#][^\s]*)?/g;

/**
 * Confluence page URL — matches e.g.:
 *   https://host/wiki/spaces/SPACE/pages/12345678
 *   https://host/wiki/spaces/SPACE/pages/12345678/PageTitle
 *
 * Capture group 1 = the numeric page ID.
 */
const CONFLUENCE_URL_RE =
  /https?:\/\/[^/\s]+\/wiki\/spaces\/[^/\s]+\/pages\/(\d+)(?:\/[^\s]*)?(?:[?#][^\s]*)?/g;

/**
 * Bare Jira key — word-boundary anchored.
 * Matches: PROJ-123, AB-1, AIBM3-456  (first letter uppercase, rest uppercase/digit).
 *
 * Capture group 1 = the full key.
 */
const BARE_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

// ---------------------------------------------------------------------------
// detectRefs
// ---------------------------------------------------------------------------

/**
 * Scan `text` for Atlassian references and return a deduplicated, capped list.
 *
 * Detection order (and precedence for dedup):
 *   1. Jira browse/issues URLs  → `{ kind:"jira",  ref: key }`
 *   2. Confluence pages URLs    → `{ kind:"confluence", ref: id }`
 *   3. Bare Jira keys           → `{ kind:"jira",  ref: key }` (filtered by jiraProjects)
 *
 * A Jira key found via URL is NOT re-added when the same key also appears as a
 * bare token ("URL precedence").
 */
export function detectRefs(text: string, opts: DetectRefsOptions = {}): PrefetchRef[] {
  const { jiraProjects = [], max = 5 } = opts;

  const seen = new Set<string>(); // "jira:PROJ-123" | "confluence:12345"
  const refs: PrefetchRef[] = [];

  function add(kind: "jira" | "confluence", ref: string): void {
    const dedupeKey = `${kind}:${ref}`;
    if (seen.has(dedupeKey) || refs.length >= max) return;
    seen.add(dedupeKey);
    refs.push({ kind, ref });
  }

  // 1. Jira URLs (always accepted regardless of jiraProjects filter)
  for (const m of text.matchAll(JIRA_URL_RE)) {
    add("jira", m[1] as string);
  }

  // 2. Confluence URLs
  for (const m of text.matchAll(CONFLUENCE_URL_RE)) {
    add("confluence", m[1] as string);
  }

  // 3. Bare Jira keys (filtered, skipped if already added via URL)
  for (const m of text.matchAll(BARE_KEY_RE)) {
    const key = m[1] as string;
    if (seen.has(`jira:${key}`)) continue; // already captured via URL
    if (jiraProjects.length > 0) {
      const project = key.replace(/-\d+$/, "");
      if (!jiraProjects.includes(project)) continue;
    }
    add("jira", key);
  }

  return refs;
}
