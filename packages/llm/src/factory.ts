import type { LlmProvider } from "./provider.js";
import type { LlmConfig } from "./config.js";
import { MockProvider } from "./mock-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatibleProvider } from "./openai-provider.js";

export function createProvider(config: LlmConfig): LlmProvider {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) throw new Error(`env var ${config.apiKeyEnv} not set`);
  const opts = { apiKey, model: config.model, baseUrl: config.baseUrl, jsonMode: config.jsonMode };
  return config.provider === "anthropic"
    ? new AnthropicProvider(opts)
    : new OpenAICompatibleProvider(opts);
}

export function createProviderOrMock(config: LlmConfig | null): LlmProvider {
  if (!config || !process.env[config.apiKeyEnv]) {
    return new MockProvider({ candidates: [] });
  }
  return createProvider(config);
}
