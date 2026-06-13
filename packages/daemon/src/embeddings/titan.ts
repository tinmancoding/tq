import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Embedder, TqConfig } from "@tq/core";

const MAX_INPUT_CHARS = 40_000; // Titan V2 input cap is generous; truncate long bodies.

/**
 * Amazon Titan Text Embeddings V2 via Bedrock InvokeModel. Uses the standard
 * AWS credential chain (profile/keys/SSO, or AWS_BEARER_TOKEN_BEDROCK).
 */
export class TitanEmbedder implements Embedder {
  readonly dims: number;
  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;

  constructor(cfg: TqConfig) {
    this.dims = cfg.embeddings.dims;
    this.modelId = cfg.embeddings.model;
    this.client = new BedrockRuntimeClient({ region: cfg.aws.region });
  }

  async embed(text: string): Promise<number[]> {
    const input = text.slice(0, MAX_INPUT_CHARS) || " ";
    const res = await this.client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({ inputText: input, dimensions: this.dims, normalize: true }),
      }),
    );
    const json = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
    if (!Array.isArray(json.embedding)) {
      throw new Error("titan: missing embedding in response");
    }
    return json.embedding;
  }
}
