/// <reference path="./turndown-plugin-gfm.d.ts" />
/**
 * Content shaping: HTML → Markdown + truncation.
 *
 * Both Jira (`renderedFields.description`) and Confluence (`body.view.value`)
 * return HTML. We convert to Markdown with turndown — a single pipeline for
 * both systems (Q9). Script/style tags are stripped before conversion so noise
 * doesn't pollute the LLM context.
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const td = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "_",
  strongDelimiter: "**",
  linkStyle: "referenced",
});

// Strip script and style elements entirely — they add noise without value.
td.remove(["script", "style", "head", "meta", "noscript"]);

// GFM plugin: enables proper table rendering + strikethrough + task list items.
td.use(gfm);

/**
 * Convert an HTML string to Markdown.
 * Returns an empty string if `html` is null/undefined/empty.
 */
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";
  return td.turndown(html);
}

/**
 * Truncate a string to at most `maxChars` characters.
 * If truncated, appends an ellipsis note so the reader knows it was cut.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return cut + `\n\n…[truncated — ${text.length - maxChars} chars omitted]`;
}
