import OpenAI from "openai";
import { proxyFetch } from "@traceforge/shared";
import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, RunTurn, ToolCall, StreamToolsHandlers } from "./provider.js";
import { withRetry } from "./retry.js";

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface ToolAccumulator { id: string; name: string; args: string }

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
};

export function assembleOpenAIStreamChoice(chunks: OpenAIStreamChunk[]): RunTurn {
  let text = "";
  let finish: string | null | undefined;
  const tools = new Map<number, ToolAccumulator>();
  for (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;
    if (delta.content) text += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const cur = tools.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      tools.set(tc.index, cur);
    }
  }
  const toolCalls: ToolCall[] = [...tools.values()].map((tc) => ({
    id: tc.id,
    name: tc.name,
    input: JSON.parse(tc.args || "{}"),
  }));
  return { text, toolCalls, done: finish !== "tool_calls" };
}

export class OpenAICompatibleProvider implements LlmProvider {
  private client: OpenAI;
  constructor(private opts: OpenAIOptions) {
    const fetchImpl = proxyFetch();
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    const res = await withRetry("openai.extractJson", () => this.client.chat.completions.create({
      model: this.opts.model,
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction", schema: args.schema },
      },
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
    }));
    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error("no content in response");
    return JSON.parse(content);
  }

  async runTools(args: RunToolsArgs): Promise<RunTurn> {
    // 用 OpenAI 原生 tool-calling：tools(function) 参数 + tool_calls/tool 消息。
    const msgs = this.toOpenAIMessages(args);
    const res = await withRetry("openai.runTools", () => this.client.chat.completions.create({
      model: this.opts.model,
      messages: msgs as never,
      tools: args.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }), { onRetry: mapRetry(args.onRetry) });
    const choice = res.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => {
      const fn = (tc as { function: { name: string; arguments: string } }).function;
      return { id: tc.id, name: fn.name, input: JSON.parse(fn.arguments || "{}") };
    });
    return { text: choice.message.content ?? "", toolCalls, done: choice.finish_reason !== "tool_calls" };
  }

  async streamTools(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn> {
    const msgs = this.toOpenAIMessages(args);
    return withRetry("openai.streamTools", async () => {
      const chunks: OpenAIStreamChunk[] = [];
      const stream = await this.client.chat.completions.create({
        model: this.opts.model,
        messages: msgs as never,
        tools: args.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        stream: true,
      }, handlers.signal ? { signal: handlers.signal } : undefined);
      for await (const chunk of stream) {
        chunks.push(chunk as OpenAIStreamChunk);
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) handlers.onTextDelta?.(delta);
      }
      return assembleOpenAIStreamChoice(chunks);
    }, { signal: handlers.signal, onRetry: mapRetry(handlers.onRetry) });
  }

  private toOpenAIMessages(args: RunToolsArgs): Array<Record<string, unknown>> {
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
    return msgs;
  }
}

function mapRetry(onRetry: RunToolsArgs["onRetry"]) {
  return onRetry
    ? (event: { attempt: number; maxAttempts: number; reason: string }) =>
      onRetry({ attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.reason })
    : undefined;
}
