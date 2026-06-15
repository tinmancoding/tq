import { readFileSync, existsSync } from "node:fs";
import type { TriageTraceStep } from "@tq/core";

/**
 * Parse a pi `.jsonl` session into a compact step list, reusing the
 * `TriageTraceStep` shape so the web can render it with the existing
 * triage-trace components. On-demand (never cached): the .jsonl is the source
 * of truth.
 */
export function parseTranscript(file: string): TriageTraceStep[] {
  if (!existsSync(file)) return [];
  const steps: TriageTraceStep[] = [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return steps;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = m.role as string | undefined;
    if (role === "user") {
      const text = extractText(m.content);
      if (text) steps.push({ kind: "thought", text: `🧑 ${text}` });
    } else if (role === "assistant") {
      const content = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          steps.push({ kind: "thought", text: block.text.trim() });
        } else if (block.type === "toolCall" && typeof block.name === "string") {
          steps.push({ kind: "tool_call", tool: block.name, args: block.arguments ?? {} });
        }
      }
      if (m.stopReason === "error" && typeof m.errorMessage === "string") {
        steps.push({ kind: "error", text: m.errorMessage });
      }
    } else if (role === "toolResult" || m.type === "toolResult") {
      const content = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
      const text = content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      steps.push({
        kind: "tool_result",
        tool: typeof m.toolName === "string" ? m.toolName : "tool",
        ok: m.isError !== true,
        text: text.slice(0, 4000),
      });
    }
  }
  return steps;
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("\n").trim() || null;
  }
  return null;
}
