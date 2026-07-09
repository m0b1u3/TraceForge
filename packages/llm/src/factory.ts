import type { LlmProvider } from "./provider.js";
import type { LlmConfig } from "./config.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatibleProvider } from "./openai-provider.js";

export function createProvider(config: LlmConfig): LlmProvider {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error("apiKey is missing");
  const opts = { apiKey, model: config.model, baseUrl: config.baseUrl, jsonMode: config.jsonMode };
  return config.provider === "anthropic"
    ? new AnthropicProvider(opts)
    : new OpenAICompatibleProvider(opts);
}

export function createProviderFromConfig(config: LlmConfig | null): LlmProvider {
  if (!config) throw new Error("LLM config missing: create config/llm.json before starting AI features");
  return createProvider(config);
}
