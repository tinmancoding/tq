import { tmpdir } from "node:os";
import { Type } from "@sinclair/typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  buildTriagePrompt,
  TriageResultSchema,
  type TqConfig,
  type TriageEngine,
  type TriageInput,
  type TriageResult,
  type TriageSearchFn,
} from "@tq/core";

/**
 * Runs a triage pass with a pi SDK session against Bedrock (Claude). Exposes
 * two custom tools to the model: `search_tasks` (hybrid search) and
 * `emit_triage` (the structured output — the model must call it exactly once).
 */
export class PiTriageEngine implements TriageEngine {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);

  constructor(private readonly cfg: TqConfig) {}

  /** True if the configured triage model is resolvable (creds/model present). */
  probe(): boolean {
    return !!this.modelRegistry.find(this.cfg.triage.provider, this.cfg.triage.model);
  }

  async triage(input: TriageInput, searchTasks: TriageSearchFn): Promise<TriageResult> {
    const model = this.modelRegistry.find(this.cfg.triage.provider, this.cfg.triage.model);
    if (!model) {
      throw new Error(
        `triage model not found: ${this.cfg.triage.provider}/${this.cfg.triage.model}`,
      );
    }

    let captured: TriageResult | undefined;

    const searchTool = defineTool({
      name: "search_tasks",
      label: "Search tasks",
      description:
        "Search existing tasks (hybrid keyword/semantic) to find duplicates or related work. Returns candidate tasks with id, title, snippet, labels, status, score.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query (keywords, refs, the core noun)." }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
      }),
      execute: async (_id, params) => {
        const hits = searchTasks(params.query, params.limit ?? 10);
        return {
          content: [{ type: "text", text: JSON.stringify(hits, null, 2) }],
          details: { count: hits.length },
        };
      },
    });

    const emitTool = defineTool({
      name: "emit_triage",
      label: "Emit triage result",
      description:
        "Emit the final structured triage result. Call this EXACTLY ONCE. This call is your answer.",
      parameters: TriageResultSchema,
      execute: async (_id, params) => {
        captured = params as TriageResult;
        return { content: [{ type: "text", text: "triage recorded" }], details: {} };
      },
    });

    // Neutral cwd so we don't pick up the user's project skills/extensions.
    const loader = new DefaultResourceLoader({
      cwd: tmpdir(),
      agentDir: getAgentDir(),
      systemPromptOverride: () => buildTriagePrompt(this.cfg.triage.label_vocabulary),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: tmpdir(),
      model,
      thinkingLevel: "off",
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      tools: ["search_tasks", "emit_triage"],
      customTools: [searchTool, emitTool],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(tmpdir()),
    });

    try {
      await session.prompt(buildUserPrompt(input), {
        images: input.images.map((img) => ({
          type: "image" as const,
          data: img.dataBase64,
          mimeType: img.mediaType,
        })),
      });
    } finally {
      session.dispose();
    }

    if (!captured) {
      throw new Error("triage agent did not call emit_triage");
    }
    return captured;
  }
}

function buildUserPrompt(input: TriageInput): string {
  const { intake } = input;
  const parts: string[] = ["# Intake to triage", ""];
  if (intake.source !== "manual") {
    parts.push(`Source: ${intake.source}${intake.source_ref ? ` (${intake.source_ref})` : ""}`);
  }
  if (intake.labels && Object.keys(intake.labels).length > 0) {
    parts.push(
      `Capture labels: ${Object.entries(intake.labels)
        .map(([k, v]) => `${k}:${v}`)
        .join(", ")}`,
    );
  }
  if (intake.action_verbs && intake.action_verbs.length > 0) {
    parts.push(`Hinted verbs: ${intake.action_verbs.join(", ")}`);
  }
  parts.push("", "## Body", intake.body ?? "(no text body)");
  if (input.images.length > 0) {
    parts.push("", `(${input.images.length} screenshot(s) attached — read any text in them.)`);
  }
  parts.push(
    "",
    "Search for duplicates/related tasks, then call emit_triage exactly once.",
  );
  return parts.join("\n");
}
