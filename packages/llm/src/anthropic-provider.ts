import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, ExtractJsonArgs } from "./provider.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  constructor(private opts: AnthropicOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
  }

  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    // thinking:adaptive 与 output_config 字段名取自 claude-api 文档；
    // 当前安装的 SDK 类型尚未包含这两个字段，故整体断言兜底（运行时由 API 接受）。
    const params = {
      model: this.opts.model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: args.schema } },
      system: args.system,
      messages: [{ role: "user", content: args.user }],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;
    const res = await this.client.messages.create(params);
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text block in response");
    return JSON.parse(text.text);
  }
}
