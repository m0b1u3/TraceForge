import OpenAI from "openai";
import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, RunTurn, ToolCall } from "./provider.js";

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class OpenAICompatibleProvider implements LlmProvider {
  private client: OpenAI;
  constructor(private opts: OpenAIOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
  }

  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    const res = await this.client.chat.completions.create({
      model: this.opts.model,
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction", schema: args.schema },
      },
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
    });
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error("no content in response");
    return JSON.parse(content);
  }

  async runTools(args: RunToolsArgs): Promise<RunTurn> {
    // 用 OpenAI 原生 tool-calling：tools(function) 参数 + tool_calls/tool 消息。
    const msgs: Array<Record<string, unknown>> = [{ role: "system", content: args.system }];
    for (const m of args.messages) {
      if (m.role === "tool") {
        msgs.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        msgs.push({
          role: "assistant", content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) } })),
        });
      } else {
        msgs.push({ role: m.role, content: m.content });
      }
    }
    const res = await this.client.chat.completions.create({
      model: this.opts.model,
      messages: msgs as never,
      tools: args.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    });
    const choice = res.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => {
      const fn = (tc as { function: { name: string; arguments: string } }).function;
      return { id: tc.id, name: fn.name, input: JSON.parse(fn.arguments || "{}") };
    });
    return { text: choice.message.content ?? "", toolCalls, done: choice.finish_reason !== "tool_calls" };
  }
}
