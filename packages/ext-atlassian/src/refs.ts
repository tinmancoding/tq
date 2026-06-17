/**
 * refs.ts — detect and parse Jira/Confluence references from text.
 *
 * Two entry points:
 *   parseRef(input)      — parse a single URL or key/id string
 *   extractRefs(text, …) — scan free text for all Jira/Confluence refs
 *
 * Used by the prefetch path (Q10): scan intake body + source_ref,
 * filter/dedupe/cap 5, then lean-fetch each ref.
 */

/** A parsed reference pointing at a Jira issue or Confluence page. */
export type ParsedRef =
  | { kind: "jira"; key: string }
  | { kind: "confluence"; id: string };

// ---------------------------------------------------------------------------
// URL patterns
// ---------------------------------------------------------------------------

/** Matches Jira issue URLs like:
 *   https://host/browse/PROJ-123
 *   https://host/jira/browse/PROJ-123
 */
const JIRA_URL_RE =
  /https?:\/\/[^/\s]+(?:\/jira)?\/browse\/([A-Z][A-Z0-9]+-\d+)(?:[?#][^\s]*)?/g;

/** Matches Confluence page URLs like:
 *   https://host/wiki/spaces/SPACE/pages/12345678/…
 *   https://host/wiki/spaces/SPACE/pages/12345678
 *   Also short-form: https://host/wiki/x/XXXX (deferred per design §6)
 */
const CONFLUENCE_URL_RE =
  /https?:\/\/[^/\s]+\/wiki\/spaces\/[^/\s]+\/pages\/(\d+)(?:\/[^\s]*)?(?:[?#][^\s]*)?/g;

/** Bare Jira key pattern (no URL prefix). Must be word-boundary-anchored.
 *  Matches e.g. PROJ-123, AB-1, AIBM3-456
 */
const BARE_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

// ---------------------------------------------------------------------------
// parseRef
// ---------------------------------------------------------------------------

/**
 * Parse a single input string as a Jira/Confluence reference.
 *
 * Accepts:
 *   - A full Jira browse URL → `{ kind: "jira", key }`
 *   - A full Confluence pages URL → `{ kind: "confluence", id }`
 *   - A bare Jira key (e.g. "PROJ-123") → `{ kind: "jira", key }`
 *   - A numeric Confluence page id string → `{ kind: "confluence", id }`
 *
 * Returns `null` for unrecognised input.
 */
export function parseRef(input: string): ParsedRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Jira URL
  const jiraUrlMatch = trimmed.match(
    /^https?:\/\/[^/\s]+(?:\/jira)?\/browse\/([A-Z][A-Z0-9]+-\d+)/,
  );
  if (jiraUrlMatch) {
    return { kind: "jira", key: jiraUrlMatch[1] as string };
  }

  // Confluence URL
  const confUrlMatch = trimmed.match(
    /^https?:\/\/[^/\s]+\/wiki\/spaces\/[^/\s]+\/pages\/(\d+)/,
  );
  if (confUrlMatch) {
    return { kind: "confluence", id: confUrlMatch[1] as string };
  }

  // Bare Jira key
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(trimmed)) {
    return { kind: "jira", key: trimmed };
  }

  // Numeric Confluence page id
  if (/^\d+$/.test(trimmed)) {
    return { kind: "confluence", id: trimmed };
  }

  return null;
}

// ---------------------------------------------------------------------------
// extractRefs
// ---------------------------------------------------------------------------

export interface ExtractRefsOptions {
  /**
   * If non-empty, bare Jira keys are filtered to only those whose project
   * prefix matches one of these (e.g. ["PROJ", "AB"]).
   * URL-based Jira refs bypass this filter.
   */
  jiraProjects?: string[];
  /** Maximum number of refs to return (default 5). */
  cap?: number;
}

/**
 * Extract all Jira/Confluence references from a text string.
 *
 * Scans for:
 *   - Jira browse URLs
 *   - Confluence page URLs
 *   - Bare Jira keys (optionally filtered by project prefix)
 *
 * Returns deduplicated refs, capped at `options.cap` (default 5).
 */
export function extractRefs(text: string, options: ExtractRefsOptions = {}): ParsedRef[] {
  const { jiraProjects = [], cap = 5 } = options;

  const seen = new Set<string>();
  const refs: ParsedRef[] = [];

  function addRef(ref: ParsedRef): void {
    const key = ref.kind === "jira" ? `jira:${ref.key}` : `confluence:${ref.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }

  // 1. Jira URLs (highest priority — explicit links)
  for (const match of text.matchAll(JIRA_URL_RE)) {
    addRef({ kind: "jira", key: match[1] as string });
  }

  // 2. Confluence URLs
  for (const match of text.matchAll(CONFLUENCE_URL_RE)) {
    addRef({ kind: "confluence", id: match[1] as string });
  }

  // 3. Bare Jira keys — apply project-prefix filter if specified
  for (const match of text.matchAll(BARE_KEY_RE)) {
    const fullKey = match[1] as string;
    // Skip if this key was already found via a URL
    if (seen.has(`jira:${fullKey}`)) continue;

    if (jiraProjects.length > 0) {
      const project = fullKey.replace(/-\d+$/, "");
      if (!jiraProjects.includes(project)) continue;
    }

    addRef({ kind: "jira", key: fullKey });
  }

  return refs.slice(0, cap);
}
