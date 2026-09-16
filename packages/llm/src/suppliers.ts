import type { ModelProtocol, ModelSupplier } from "@traceforge/shared/model-protocol";
import type { ModelAdapterOptions } from "./adapter-options.js";

/** Connection defaults only: selecting a supplier never restricts protocol choice.
 * No account tokens, model guesses, Scenario policy or tool execution live here. */
export interface ModelSupplierDefinition {
  label: string;
  group: "domestic" | "international" | "coding";
  note?: string;
  requestOptions?: ModelAdapterOptions["requestOptions"];
  protocol: ModelProtocol;
  baseUrl: string;
  jsonMode: "json_schema" | "json_object";
}
export const MODEL_SUPPLIERS = Object.freeze({
  deepseek: { label: "DeepSeek", group: "domestic", protocol: "openai", baseUrl: "https://api.deepseek.com", jsonMode: "json_object" },
  xai: { label: "xAI / Grok", group: "international", protocol: "responses", baseUrl: "https://api.x.ai/v1", jsonMode: "json_schema", note: "API Key 在此配置；已有 Grok 订阅登录请从认证连接选择。" },
  kimi: { label: "Kimi / 月之暗面", group: "domestic", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", jsonMode: "json_object" },
  glm: { label: "智谱 GLM", group: "domestic", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", jsonMode: "json_object" },
  openai: { label: "OpenAI / GPT", group: "international", protocol: "responses", baseUrl: "https://api.openai.com/v1", jsonMode: "json_schema", requestOptions: {includeReasoningContinuation:true}, note: "使用 OpenAI API 密钥；此入口不是 ChatGPT 订阅登录。" },
  anthropic: { label: "Anthropic / Claude", group: "international", protocol: "anthropic", baseUrl: "https://api.anthropic.com", jsonMode: "json_object", note: "使用 Claude API 密钥；此入口不是 Claude Pro / Max 登录。" },
  qwen: { label: "通义千问 / 阿里百炼", group: "domestic", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", jsonMode: "json_object", note: "默认北京共享域名。地域、专属空间和套餐地址须与密钥匹配，可修改 API 地址。" },
  doubao: { label: "豆包 / 火山方舟", group: "domestic", protocol: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", jsonMode: "json_object", note: "填写控制台允许调用的模型 ID 或推理接入点 ID；模型目录不一定列出接入点。" },
  hunyuan: { label: "腾讯混元（原平台）", group: "domestic", protocol: "openai", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", jsonMode: "json_object", note: "适用于原混元平台密钥。新 TokenHub 服务请选择独立入口。" },
  tokenhub: { label: "腾讯 TokenHub", group: "domestic", protocol: "openai", baseUrl: "https://tokenhub.tencentmaas.com/v1", jsonMode: "json_object" },
  qianfan: { label: "文心 / 百度千帆", group: "domestic", protocol: "openai", baseUrl: "https://qianfan.baidubce.com/v2", jsonMode: "json_object", note: "使用千帆 v2 API Key，不是旧版 AK/SK 签名认证。" },
  spark: { label: "讯飞星火", group: "domestic", protocol: "openai", baseUrl: "https://spark-api-open.xf-yun.com/agent/v1", jsonMode: "json_object", note: "此为 X2 HTTP 入口，密钥填写 APIPassword；其他型号按官方说明修改地址，不使用 WebSocket 签名密钥。" },
  minimax: { label: "MiniMax（国内）", group: "domestic", protocol: "anthropic", baseUrl: "https://api.minimaxi.com/anthropic", jsonMode: "json_object" },
  stepfun: { label: "阶跃星辰 / StepFun", group: "domestic", protocol: "openai", baseUrl: "https://api.stepfun.com/v1", jsonMode: "json_object", note: "普通 API 入口；Step Plan 套餐使用其专属地址。" },
  siliconflow: { label: "硅基流动", group: "domestic", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1", jsonMode: "json_object", note: "可选择平台托管的国产模型；各型号的工具调用能力不同。" },
  xiaomi: { label: "小米 MiMo", group: "domestic", protocol: "openai", baseUrl: "https://api.xiaomimimo.com/v1", jsonMode: "json_object" },
  "kimi-coding": { label: "Kimi Coding", group: "coding", protocol: "anthropic", baseUrl: "https://api.kimi.com/coding", jsonMode: "json_object", note: "填写 Kimi Coding 专用 API Key，与普通 Kimi API 分开；本入口不提供订阅 OAuth 登录。" },
  "glm-coding": { label: "GLM Coding", group: "coding", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", jsonMode: "json_object", note: "使用 Coding 套餐适用的密钥与模型，套餐权限由供应商决定。" },
  "minimax-global": { label: "MiniMax（国际）", group: "international", protocol: "anthropic", baseUrl: "https://api.minimax.io/anthropic", jsonMode: "json_object" },
  "moonshot-global": { label: "Kimi / Moonshot（国际）", group: "international", protocol: "openai", baseUrl: "https://api.moonshot.ai/v1", jsonMode: "json_object" },
} as const satisfies Record<ModelSupplier, ModelSupplierDefinition>);
