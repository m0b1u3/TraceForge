import type { ModelProtocol, ModelSupplier } from "@traceforge/shared/model-protocol";

/** Connection defaults only: selecting a supplier never restricts protocol choice.
 * No account tokens, model guesses, Scenario policy or tool execution live here. */
export interface ModelSupplierDefinition {
  protocol: ModelProtocol;
  baseUrl: string;
  jsonMode: "json_schema" | "json_object";
}
export const MODEL_SUPPLIERS = Object.freeze({
  deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com", jsonMode: "json_object" },
  xai: { protocol: "openai", baseUrl: "https://api.x.ai/v1", jsonMode: "json_schema" },
  kimi: { protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", jsonMode: "json_object" },
  glm: { protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", jsonMode: "json_object" },
} as const satisfies Record<ModelSupplier, ModelSupplierDefinition>);
