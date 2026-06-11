/** Factory: pick an LLM backend from config. */

import type { Config } from "../config.js";
import type { LlmProvider } from "../types.js";
import { BedrockLlmProvider } from "./bedrock.js";
import { OpenAICompatibleLlmProvider } from "./openaiCompatible.js";
import { MockLlmProvider } from "./mock.js";

export function createLlmProvider(config: Config): LlmProvider {
  switch (config.llmProvider) {
    case "bedrock":
      return new BedrockLlmProvider(config.bedrockModelId, config.awsRegion);
    case "openai-compatible":
      return new OpenAICompatibleLlmProvider(
        config.openaiBaseUrl,
        config.openaiApiKey,
        config.openaiModel,
      );
    case "mock":
      return new MockLlmProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${config.llmProvider}`);
  }
}

export { BedrockLlmProvider, OpenAICompatibleLlmProvider, MockLlmProvider };
