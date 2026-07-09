import { createProviderFromConfig, loadLlmConfig, type LlmProvider } from "@traceforge/llm";

export function realLlmProviderForTest(): LlmProvider {
  return createProviderFromConfig(loadLlmConfig());
}
