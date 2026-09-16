/** Transport configuration shared by adapters, independent of any SDK. */
export interface ModelAdapterOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  jsonMode?: "json_schema" | "json_object";
  embeddingModel?: string;
  fetch?: typeof fetch;
  maxOutputTokens?: number;
  continuationScope?: string;
  requestOptions?: { thinking?: "enabled" | "disabled"; reasoningEffort?: string; temperature?: number; includeReasoningContinuation?: boolean };
}
