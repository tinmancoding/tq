import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  };
  embeddings: {
    model: string;
    dims: number;
  };
  aws: {
    region: string;
  };
  client: {
    actor: string;
    token?: string;
    url?: string;
  };
  secrets: Record<string, { env?: string; value?: string }>;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "tq", "config.toml");
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
      port: 7788,
      db_path: "~/.local/share/tq/tq.db",
      attachments_dir: "~/.local/share/tq/attachments",
    },
    triage: {
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      concurrency: 3,
      max_attempts: 3,
      auto_create_confidence: 0.8,
      label_vocabulary: ["project", "person", "area", "ticket", "source", "repo"],
    },
    embeddings: {
      model: "amazon.titan-embed-text-v2:0",
      dims: 1024,
    },
    aws: {
      region: "us-east-1",
    },
    client: {
      actor: "human:laci",
    },
    secrets: {},
  };
}

/**
 * Load config, merging the TOML file (if present) over defaults.
 * Path resolution order: explicit arg → $TQ_CONFIG → default path.
 */
export function loadConfig(configPath?: string): TqConfig {
  const path = configPath ?? process.env.TQ_CONFIG ?? defaultConfigPath();
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

void resolve; // reserved for future relative-path handling
