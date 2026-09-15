import type { LlmProvider } from "./provider.js";
import type { LlmConfig, LlmEndpointConfig } from "./config.js";
import { MODEL_PROTOCOL_ADAPTERS } from "./protocol-adapters.js";
import { normalizeModelConnection, modelConnectionFetch, type ModelConnectionDependencies } from "./connections.js";
import { proxyFetch } from "@traceforge/shared/proxy";
import { withContextBudget } from "./context-budget-provider.js";
import { resolveContextBudget } from "@traceforge/shared/model-context";

export function createProvider(input: LlmEndpointConfig, dependencies: ModelConnectionDependencies = {}): LlmProvider {
  const config = normalizeModelConnection(input);
  if (config.credentialRef && !dependencies.credentials) throw new Error("Managed model credential resolver is not configured");
  const apiKey = config.credentialRef ? "managed-credential-resolved-at-dispatch" : config.apiKey;
  if (!apiKey) throw new Error("apiKey is missing");
  if (/[\r\n]/.test(apiKey)) throw new Error("Invalid API key");
  const fetchImpl = modelConnectionFetch(config, { ...dependencies, fetch: dependencies.fetch ?? proxyFetch() ?? globalThis.fetch });
  const outputTokens = resolveContextBudget(config).output;
  const opts = { apiKey, model: config.model, embeddingModel: config.embeddingModel, baseUrl: config.baseUrl, jsonMode: config.jsonMode,
    fetch: fetchImpl, requestOptions: config.requestOptions, maxOutputTokens: outputTokens };
  // Exhaustive protocol registry. Supplier selection never selects a constructor.
  const Adapter = MODEL_PROTOCOL_ADAPTERS[config.provider];
  if (!Adapter) throw new Error("Unsupported model wire protocol");
  const provider = new Adapter(opts);
  return withContextBudget(provider, {
    contextWindowTokens: config.contextWindowTokens, maxOutputTokens: outputTokens,
  });
}

export function createProviderFromConfig(config: LlmConfig | null): LlmProvider {
  if (!config) throw new Error("LLM config missing: create config/llm.json before starting AI features");
  return createProvider(config);
}
