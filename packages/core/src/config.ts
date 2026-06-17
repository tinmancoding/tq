import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

export interface TqConfig {
  daemon: {
    host: string;
    port: number;
    db_path: string;
    attachments_dir: string;
  };
  triage: {
    provider: string;
    model: string;
    concurrency: number;
    max_attempts: number;
    auto_create_confidence: number;
    label_vocabulary: string[];
    thinking_level: string;
    tool_call_budget: number;
  };
  atlassian: {
    base_url: string;
    jira_projects: string[];
    request_timeout_ms: number;
    pass_timeout_ms: number;
    prefetch_max: number;
    body_markdown_max_chars: number;
    attachment_max_bytes: number;
  };
  embeddings: {
    provider: string;
    model: string;
    dims: number;
  };
  context: {
    spill_bytes: number;
  };
  aws: {
    region: string;
  };
  client: {
    actor: string;
    token?: string;
    url?: string;
  };
  extensions: Record<string, { enabled?: boolean } & Record<string, unknown>>;
  secrets: Record<string, { env?: string; value?: string }>;
}

/** Resolve the repo checkout root from this module's own location. */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/**
 * Base directory for all runtime data files (DB, attachments, run/).
 * Resolution order: $TQ_DATA → <repoRoot>/data
 */
export function dataDir(): string {
  return process.env.TQ_DATA ? expandHome(process.env.TQ_DATA) : join(repoRoot(), "data");
}

/**
 * Directory that holds config.toml and tq.env.
 * Resolution order: dirname($TQ_CONFIG) → <repoRoot>/config
 */
export function configDir(): string {
  return process.env.TQ_CONFIG
    ? dirname(expandHome(process.env.TQ_CONFIG))
    : join(repoRoot(), "config");
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function defaultConfigPath(): string {
  return process.env.TQ_CONFIG ?? join(repoRoot(), "config", "config.toml");
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const cur = (base as Record<string, unknown>)[k];
    out[k] = deepMerge(cur as unknown, v);
  }
  return out as T;
}

export function defaultConfig(): TqConfig {
  return {
    daemon: {
      host: "127.0.0.1",
      port: 7799,
      db_path: join(dataDir(), "tq.db"),
      attachments_dir: join(dataDir(), "attachments"),
    },
    triage: {
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      concurrency: 3,
      max_attempts: 3,
      auto_create_confidence: 0.8,
      label_vocabulary: ["project", "person", "area", "ticket", "source", "repo"],
      thinking_level: "low",
      tool_call_budget: 30,
    },
    atlassian: {
      base_url: "https://diligentbrands.atlassian.net",
      jira_projects: [] as string[],
      request_timeout_ms: 15000,
      pass_timeout_ms: 180000,
      prefetch_max: 5,
      body_markdown_max_chars: 8000,
      attachment_max_bytes: 26214400,
    },
    embeddings: {
      provider: "titan",
      model: "amazon.titan-embed-text-v2:0",
      dims: 1024,
    },
    context: {
      spill_bytes: 65536,
    },
    aws: {
      region: "us-east-1",
    },
    client: {
      actor: "human:laci",
    },
    extensions: {
      triage: { enabled: true },
      "search-semantic": { enabled: true },
      atlassian: { enabled: true },
    },
    secrets: {},
  };
}

/**
 * Load config, merging the TOML file (if present) over defaults.
 * Path resolution order: explicit arg → $TQ_CONFIG → default path.
 */
export function loadConfig(configPath?: string): TqConfig {
  const path = configPath ?? defaultConfigPath();
  let merged = defaultConfig();
  if (existsSync(path)) {
    const raw = parseToml(readFileSync(path, "utf8"));
    merged = deepMerge(merged, raw);
  }
  // Normalize path-like fields.
  merged.daemon.db_path = expandHome(merged.daemon.db_path);
  merged.daemon.attachments_dir = expandHome(merged.daemon.attachments_dir);
  return merged;
}

/** Resolve the daemon base URL clients should talk to. */
export function daemonBaseUrl(cfg: TqConfig): string {
  if (cfg.client.url) return cfg.client.url.replace(/\/$/, "");
  return `http://${cfg.daemon.host}:${cfg.daemon.port}`;
}

/** Resolve a named secret to its value (via env or inline). */
export function resolveSecret(cfg: TqConfig, name: string): string | undefined {
  const entry = cfg.secrets[name];
  if (!entry) return undefined;
  if (entry.env) return process.env[entry.env];
  return entry.value;
}


