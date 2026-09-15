import type { ModelProtocol } from "@traceforge/shared/model-protocol";
import type { ModelAdapterOptions } from "./adapter-options.js";
import type { LlmProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatibleProvider } from "./openai-provider.js";
import { ResponsesProvider } from "./responses-provider.js";

/** Protocol dispatch is deliberately independent of supplier/credential catalogs.
 * A new supplier reuses an adapter; a new wire protocol implements this contract. */
export const MODEL_PROTOCOL_ADAPTERS = Object.freeze({
  anthropic: AnthropicProvider,
  openai: OpenAICompatibleProvider,
  responses: ResponsesProvider,
} satisfies Record<ModelProtocol, new (options: ModelAdapterOptions) => LlmProvider>);
