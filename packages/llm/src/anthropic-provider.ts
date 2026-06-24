import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, RunTurn, ToolCall } from "./provider.js";

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

  async runTools(args: RunToolsArgs): Promise<RunTurn> {
    // 用 Anthropic 原生 tool-calling：tools 参数 + tool_use/tool_result 块。
    // SDK 类型对 thinking:adaptive 不全，整体断言兜底（同 extractJson）。
    const anthropicMessages = args.messages.map((m) => {
      if (m.role === "tool") {
        return { role: "user" as const, content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant" as const,
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })),
          ],
        };
      }
      return { role: m.role as "user" | "assistant", content: m.content };
    });
    const params = {
      model: this.opts.model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: args.system,
      tools: args.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: anthropicMessages,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;
    const res = await this.client.messages.create(params);
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    return { text, toolCalls, done: res.stop_reason !== "tool_use" };
  }
}
