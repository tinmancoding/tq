import { describe, it, expect } from "vitest";
import { defaultConfig, loadConfig } from "../config.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

describe("defaultConfig()", () => {
  it("has the atlassian block with correct defaults", () => {
    const cfg = defaultConfig();

    expect(cfg.atlassian.base_url).toBe("https://diligentbrands.atlassian.net");
    expect(cfg.atlassian.jira_projects).toEqual([]);
    expect(cfg.atlassian.request_timeout_ms).toBe(15000);
    expect(cfg.atlassian.pass_timeout_ms).toBe(180000);
    expect(cfg.atlassian.prefetch_max).toBe(5);
    expect(cfg.atlassian.body_markdown_max_chars).toBe(8000);
    expect(cfg.atlassian.attachment_max_bytes).toBe(26214400);
  });

  it("has triage.thinking_level defaulting to 'low'", () => {
    const cfg = defaultConfig();
    expect(cfg.triage.thinking_level).toBe("low");
  });

  it("has triage.tool_call_budget defaulting to 30", () => {
    const cfg = defaultConfig();
    expect(cfg.triage.tool_call_budget).toBe(30);
  });

  it("existing triage fields still present", () => {
    const cfg = defaultConfig();
    expect(cfg.triage.provider).toBe("amazon-bedrock");
    expect(cfg.triage.concurrency).toBe(3);
    expect(cfg.triage.auto_create_confidence).toBe(0.8);
  });

  it("enables the atlassian extension by default so the host mounts it when creds are present", () => {
    // Regression: the host (host.ts) skips any extension whose config block is
    // not `enabled: true`. If atlassian is omitted here, the connector is built
    // + logged as enabled but its routes silently 404 on a default profile.
    const cfg = defaultConfig();
    expect(cfg.extensions.atlassian?.enabled).toBe(true);
    expect(cfg.extensions.triage?.enabled).toBe(true);
    expect(cfg.extensions["search-semantic"]?.enabled).toBe(true);
  });
});

describe("loadConfig() deepMerge — atlassian overrides", () => {
  function writeToml(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "tq-cfg-test-"));
    const path = join(dir, "config.toml");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("partial atlassian override merges with defaults", () => {
    const path = writeToml(`
[atlassian]
base_url = "https://custom.atlassian.net"
jira_projects = ["PROJ", "TEAM"]
`);
    const cfg = loadConfig(path);

    // Overridden
    expect(cfg.atlassian.base_url).toBe("https://custom.atlassian.net");
    expect(cfg.atlassian.jira_projects).toEqual(["PROJ", "TEAM"]);

    // Defaults preserved
    expect(cfg.atlassian.request_timeout_ms).toBe(15000);
    expect(cfg.atlassian.pass_timeout_ms).toBe(180000);
    expect(cfg.atlassian.prefetch_max).toBe(5);
    expect(cfg.atlassian.body_markdown_max_chars).toBe(8000);
    expect(cfg.atlassian.attachment_max_bytes).toBe(26214400);
  });

  it("can override individual timeout fields without touching others", () => {
    const path = writeToml(`
[atlassian]
request_timeout_ms = 30000
[triage]
tool_call_budget = 50
`);
    const cfg = loadConfig(path);

    expect(cfg.atlassian.request_timeout_ms).toBe(30000);
    expect(cfg.triage.tool_call_budget).toBe(50);
    // Others still default
    expect(cfg.atlassian.base_url).toBe("https://diligentbrands.atlassian.net");
    expect(cfg.atlassian.prefetch_max).toBe(5);
  });

  it("triage.thinking_level can be overridden", () => {
    const path = writeToml(`
[triage]
thinking_level = "high"
`);
    const cfg = loadConfig(path);
    expect(cfg.triage.thinking_level).toBe("high");
    // Other triage fields still present
    expect(cfg.triage.provider).toBe("amazon-bedrock");
    expect(cfg.triage.concurrency).toBe(3);
  });

  it("empty config file returns all defaults", () => {
    const path = writeToml("");
    const cfg = loadConfig(path);
    expect(cfg.atlassian.base_url).toBe("https://diligentbrands.atlassian.net");
    expect(cfg.triage.thinking_level).toBe("low");
  });
});
