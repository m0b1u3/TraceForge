/** Browser-safe model connection vocabulary. No SDK, credentials or host I/O. */
export const MODEL_PROTOCOLS = ["openai", "anthropic", "responses"] as const;
export type ModelProtocol = typeof MODEL_PROTOCOLS[number];
export const MODEL_SUPPLIER_IDS = ["deepseek", "xai", "kimi", "glm"] as const;
export type ModelSupplier = typeof MODEL_SUPPLIER_IDS[number];
