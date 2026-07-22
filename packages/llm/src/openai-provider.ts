import OpenAI from "openai";
import { proxyFetch } from "@traceforge/shared/proxy";
import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, RunTurn, ToolCall, StreamToolsHandlers, UsageSnapshot } from "./provider.js";
import { withRetry } from "./retry.js";

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  jsonMode?: "json_schema" | "json_object";
}

interface ToolAccumulator { id: string; name: string; args: string }

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
    message?: { content?: string | null; reasoning_content?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

function extractText(choice: { message?: { content?: string | null; reasoning_content?: string | null } } | undefined): string | undefined {
  const msg = choice?.message;
  const content = msg?.content?.trim();
  if (content) return content;
  const reasoning = (msg as { reasoning_content?: string | null } | undefined)?.reasoning_content?.trim();
  return reasoning || undefined;
}

function extractReasoning(choice: { message?: { content?: string | null; reasoning_content?: string | null } } | undefined): string | undefined {
  const msg = choice?.message;
  const content = msg?.content?.trim();
  const reasoning = (msg as { reasoning_content?: string | null } | undefined)?.reasoning_content?.trim();
  if (!reasoning) return undefined;
  if (content && reasoning === content) return undefined;
  return reasoning;
}

export function assembleOpenAIStreamChoice(chunks: OpenAIStreamChunk[]): RunTurn {
  let contentText = "";
  let reasoningText = "";
  let finish: string | null | undefined;
  const tools = new Map<number, ToolAccumulator>();
  for (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;
    if (delta.content) contentText += delta.content;
    if (delta.reasoning_content) reasoningText += delta.reasoning_content;
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
  const text = contentText || reasoningText;
  const reasoning = reasoningText && reasoningText !== contentText ? reasoningText : undefined;
  return { text, reasoning, toolCalls, done: finish !== "tool_calls" };
}

export class OpenAICompatibleProvider implements LlmProvider {
  private client: OpenAI;
  constructor(private opts: OpenAIOptions) {
    const fetchImpl = proxyFetch();
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    if (this.opts.jsonMode === "json_object") return this.extractJsonObject(args);

    let res;
    try {
      res = await withRetry("openai.extractJson", () => this.client.chat.completions.create({
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
    } catch (error) {
      if (!isResponseFormatUnavailable(error) && !isEmptyJsonResponseError(error)) throw error;
      res = await withRetry("openai.extractJson.fallback", () => this.client.chat.completions.create({
        model: this.opts.model,
        messages: [
          { role: "system", content: `${args.system}\n只输出一个 JSON 对象，不要输出 Markdown 或解释文字。JSON 必须符合这个 schema：${JSON.stringify(args.schema)}` },
          { role: "user", content: args.user },
        ],
      }));
    }
    const content = extractText(res.choices[0]);
    if (!content) throw new Error("no content in response");
    emitUsage(args.onUsage, res.usage);
    return JSON.parse(content);
  }

  private async extractJsonObject(args: ExtractJsonArgs): Promise<unknown> {
    let res;
    try {
      res = await withRetry("openai.extractJson.jsonObject", async () => {
        const response = await this.client.chat.completions.create({
          model: this.opts.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: jsonObjectSystemPrompt(args.system, args.schema) },
            { role: "user", content: args.user },
          ],
        });
        const content = extractText(response.choices[0]);
        if (!content) throw retryableEmptyContentError();
        return response;
      });
    } catch (error) {
      if (isResponseFormatUnavailable(error) || isEmptyJsonResponseError(error)) {
        res = await withRetry("openai.extractJson.jsonObject.fallback", () => this.client.chat.completions.create({
          model: this.opts.model,
          messages: [
            { role: "system", content: jsonObjectSystemPrompt(args.system, args.schema) },
            { role: "user", content: args.user },
          ],
        }));
      } else {
        throw error;
      }
    }
    const content = extractText(res.choices[0]);
    if (!content) throw new Error("no content in response");
    emitUsage(args.onUsage, res.usage);
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
    emitUsage(args.onUsage, res.usage);
    return { text: extractText(choice) ?? "", reasoning: extractReasoning(choice), toolCalls, done: choice.finish_reason !== "tool_calls" };
  }

  async streamTools(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn> {
    const msgs = this.toOpenAIMessages(args);
    return withRetry("openai.streamTools", async () => {
      const chunks: OpenAIStreamChunk[] = [];
      let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      const stream = await this.client.chat.completions.create({
        model: this.opts.model,
        messages: msgs as never,
        tools: args.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        stream: true,
        stream_options: { include_usage: true },
      }, handlers.signal ? { signal: handlers.signal } : undefined);
      for await (const chunk of stream) {
        chunks.push(chunk as OpenAIStreamChunk);
        const c = chunk as OpenAIStreamChunk;
        if (c.usage) usage = c.usage;
        const delta = c.choices?.[0]?.delta?.content ?? "";
        if (delta) handlers.onTextDelta?.(delta);
      }
      const turn = assembleOpenAIStreamChoice(chunks);
      emitUsage(handlers.onUsage, usage);
      return turn;
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

function isResponseFormatUnavailable(error: unknown): boolean {
  const err = error as { status?: number; message?: string; error?: { message?: string } };
  const message = `${err.message ?? ""} ${err.error?.message ?? ""}`.toLowerCase();
  return err.status === 400 && message.includes("response_format") && message.includes("unavailable");
}

function isEmptyJsonResponseError(error: unknown): boolean {
  const err = error as { message?: string };
  const message = String(err.message ?? "").toLowerCase();
  return message.includes("empty content") || message.includes("no content");
}

function jsonObjectSystemPrompt(system: string, schema: Record<string, unknown>): string {
  return [
    system,
    "只输出一个 JSON object，不要输出 Markdown 或解释文字。",
    `JSON 必须符合这个 schema：${JSON.stringify(schema)}`,
    `JSON 输出示例：${exampleJsonForSchema(schema)}`,
  ].join("\n");
}

function exampleJsonForSchema(schema: Record<string, unknown>): string {
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : {};
  const example: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    example[key] = exampleValue(value);
  }
  return JSON.stringify(example);
}

function exampleValue(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return null;
  const type = (schema as { type?: unknown }).type;
  if (type === "array") return [];
  if (type === "object") return {};
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  return "";
}

function retryableEmptyContentError(): Error & { status: number } {
  const error = new Error("empty content in JSON response") as Error & { status: number };
  error.status = 503;
  return error;
}

function emitUsage(
  onUsage: ((usage: UsageSnapshot) => void) | undefined,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
): void {
  if (!onUsage || !usage) return;
  onUsage({
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  });
}
