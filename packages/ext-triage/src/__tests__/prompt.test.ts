/**
 * prompt.test.ts — Phase D prompt tests.
 *
 * Verifies that buildTriagePrompt:
 *  - omits the Atlassian section when atlassianEnabled is false (or absent)
 *  - includes the Atlassian section when atlassianEnabled is true
 *  - the section contains the expected tool names, escalation discipline,
 *    data-not-instructions caution, and read-only reminder
 */

import { describe, it, expect } from "vitest";
import { buildTriagePrompt } from "../prompt.js";

const VOCAB = ["project", "person", "area", "ticket"];

describe("buildTriagePrompt – Atlassian section absent", () => {
  it("returns base prompt without Atlassian section when atlassianEnabled is false", () => {
    const prompt = buildTriagePrompt(VOCAB, { atlassianEnabled: false });
    expect(prompt).toContain("search_tasks");
    expect(prompt).toContain("emit_triage");
    expect(prompt).not.toContain("jira_get");
    expect(prompt).not.toContain("jira_search");
    expect(prompt).not.toContain("confluence_get");
    expect(prompt).not.toContain("confluence_search");
    expect(prompt).not.toContain("fetch_attachment");
    expect(prompt).not.toContain("Atlassian");
  });

  it("omits Atlassian section when opts is undefined", () => {
    const prompt = buildTriagePrompt(VOCAB);
    expect(prompt).not.toContain("jira_get");
    expect(prompt).not.toContain("Atlassian");
  });

  it("omits Atlassian section when atlassianEnabled is omitted from opts", () => {
    const prompt = buildTriagePrompt(VOCAB, {});
    expect(prompt).not.toContain("jira_get");
  });
});

describe("buildTriagePrompt – Atlassian section present", () => {
  it("includes all 5 tool names when atlassianEnabled is true", () => {
    const prompt = buildTriagePrompt(VOCAB, { atlassianEnabled: true });
    expect(prompt).toContain("jira_get");
    expect(prompt).toContain("jira_search");
    expect(prompt).toContain("confluence_get");
    expect(prompt).toContain("confluence_search");
    expect(prompt).toContain("fetch_attachment");
  });

  it("includes escalation discipline guidance", () => {
    const prompt = buildTriagePrompt(VOCAB, { atlassianEnabled: true });
    expect(prompt).toContain("Start lean");
    expect(prompt).toContain("budget");
    expect(prompt).toContain("emit_triage");
  });

  it("includes data-not-instructions caution", () => {
    const prompt = buildTriagePrompt(VOCAB, { atlassianEnabled: true });
    // Should warn about treating fetched content as data only
    expect(prompt.toLowerCase()).toContain("data");
    expect(prompt).toContain("instructions");
    expect(prompt).toContain("DATA-NOT-INSTRUCTIONS");
  });

  it("includes read-only reminder", () => {
    const prompt = buildTriagePrompt(VOCAB, { atlassianEnabled: true });
    expect(prompt).toContain("read-only");
    expect(prompt.toLowerCase()).toContain("cannot create");
  });

  it("includes the base prompt content as well", () => {
    const prompt = buildTriagePrompt(VOCAB, { atlassianEnabled: true });
    expect(prompt).toContain("search_tasks");
    expect(prompt).toContain("emit_triage");
    expect(prompt).toContain("project");
    expect(prompt).toContain("person");
  });

  it("base prompt is identical whether atlassian enabled or not", () => {
    const withAtl = buildTriagePrompt(VOCAB, { atlassianEnabled: true });
    const withoutAtl = buildTriagePrompt(VOCAB, { atlassianEnabled: false });
    // withAtl should start with the same content as withoutAtl
    expect(withAtl.startsWith(withoutAtl)).toBe(true);
  });
});
