import Anthropic from "@anthropic-ai/sdk";
import { proxyFetch } from "@traceforge/shared/proxy";
import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, RunTurn, ToolCall, UsageSnapshot, StreamToolsHandlers } from "./provider.js";
import { withRetry } from "./retry.js";
import { normalizeToolHistory } from "./tool-history.js";
import type { ModelAdapterOptions } from "./adapter-options.js";
import { modelStreamEvents } from "./stream-events.js";

export type AnthropicOptions = ModelAdapterOptions;

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  constructor(private opts: AnthropicOptions) {
    if (opts.requestOptions?.reasoningEffort !== undefined) throw new Error("Anthropic connection does not support reasoningEffort; use thinking instead");
    const fetchImpl = opts.fetch ?? proxyFetch();
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl, maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  private parameters() {
    const thinking = this.opts.requestOptions?.thinking;
    return {
      ...(thinking === "enabled" ? { thinking: { type: "adaptive" } } : thinking === "disabled" ? { thinking: { type: "disabled" } } : {}),
      ...(this.opts.requestOptions?.temperature === undefined ? {} : { temperature: this.opts.requestOptions.temperature }),
    };
  }

  async extractJson(args: ExtractJsonArgs): Promise<unknown> {
    // thinking:adaptive 与 output_config 字段名取自 claude-api 文档；
    // 当前安装的 SDK 类型尚未包含这两个字段，故整体断言兜底（运行时由 API 接受）。
    const params = {
      model: this.opts.model,
      max_tokens: this.opts.maxOutputTokens ?? 4096,
      ...this.parameters(),
      ...(this.opts.jsonMode === "json_schema" ? { output_config: { format: { type: "json_schema", schema: args.schema } } } : {}),
      system: `${args.system}\nReturn JSON matching: ${JSON.stringify(args.schema)}`,
      messages: [{ role: "user", content: args.user }],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;
    if (args.onReasoningDelta) {
      const stream = this.client.messages.stream(params, { signal: args.signal, maxRetries: 0 });
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") args.onReasoningDelta(event.delta.thinking);
        }
        const message = await stream.finalMessage();
        if (!["end_turn", "stop_sequence"].includes(message.stop_reason ?? "")) throw new Error("Incomplete model JSON stream");
        emitUsage(args.onUsage, message.usage);
        return JSON.parse(anthropicTurn(message).text);
      } finally { stream.abort(); }
    }
    const res = await withRetry(
      "anthropic.extractJson",
      () => this.client.messages.create(params, args.signal ? { signal: args.signal } : undefined),
      { signal: args.signal },
    );
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text block in response");
    emitUsage(args.onUsage, res.usage);
    return JSON.parse(text.text);
  }

  async runTools(args: RunToolsArgs): Promise<RunTurn> {
    const res = await withRetry("anthropic.runTools", () => this.client.messages.create(this.toolParameters(args)), { onRetry: mapRetry(args.onRetry) });
    emitUsage(args.onUsage, res.usage);
    return anthropicTurn(res);
  }

  async streamTools(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn> {
    return modelStreamEvents(handlers, events => this.nativeStreamTools(args, events));
  }
  private async nativeStreamTools(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn> {
    const stream = this.client.messages.stream(this.toolParameters(args), { signal: handlers.signal, maxRetries: 0 });
    try {
      // Consume native protocol events; never simulate streaming from a completed response.
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") handlers.onTextDelta?.(event.delta.text);
        if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") handlers.onReasoningDelta?.(event.delta.thinking);
        if (event.type === "content_block_start" && event.content_block.type === "tool_use")
          handlers.onEvent?.({ type: "tool_call_delta", index: event.index, id: event.content_block.id, name: event.content_block.name, delta: "" });
        if (event.type === "content_block_delta" && event.delta.type === "input_json_delta")
          handlers.onEvent?.({ type: "tool_call_delta", index: event.index, delta: event.delta.partial_json });
      }
      const message = await stream.finalMessage();
      if (!["end_turn", "stop_sequence", "tool_use"].includes(message.stop_reason ?? "")) throw new Error("Incomplete model stream");
      emitUsage(handlers.onUsage, message.usage);
      return anthropicTurn(message);
    } catch (error) { stream.abort(); throw error; }
  }

  private toolParameters(args: RunToolsArgs): Anthropic.MessageCreateParamsNonStreaming {
    // 用 Anthropic 原生 tool-calling：tools 参数 + tool_use/tool_result 块。
    // SDK 类型对 thinking:adaptive 不全，整体断言兜底（同 extractJson）。
    // Anthropic 协议：一条 assistant 里的 N 个 tool_use，必须紧跟"一条" user 消息且其中含全部 N 个
    // tool_result。模型执行层把每个工具结果存为独立的 role:"tool" 消息，这里要把**连续的** tool
    // 消息合并进同一条 user 消息，否则 DeepSeek/Anthropic 端点报 "tool_use ids without tool_result"。
    const anthropicMessages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
    for (const m of normalizeToolHistory(args.messages)) {
      if (m.role === "tool") {
        const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
        const last = anthropicMessages[anthropicMessages.length - 1];
        // 若上一条已是承载 tool_result 的 user 消息，追加进去（合并连续工具结果）
        if (last && last.role === "user" && Array.isArray(last.content)
            && (last.content as Array<{ type: string }>)[0]?.type === "tool_result") {
          (last.content as unknown[]).push(block);
        } else {
          anthropicMessages.push({ role: "user", content: [block] });
        }
        continue;
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        anthropicMessages.push({
          role: "assistant",
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.toolCalls.map((tc) => ({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })),
          ],
        });
        continue;
      }
      anthropicMessages.push({ role: m.role as "user" | "assistant", content: m.content });
    }
    const params = {
      model: this.opts.model,
      max_tokens: this.opts.maxOutputTokens ?? 4096,
      ...this.parameters(),
      system: args.system,
      tools: args.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: anthropicMessages,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;
    return params;
  }
}

function anthropicTurn(res: Anthropic.Message): RunTurn {
  let text = "", reasoning = "";
  const toolCalls: ToolCall[] = [];
  for (const block of res.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "thinking") reasoning += block.thinking;
    else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  return { text, ...(reasoning ? { reasoning } : {}), toolCalls, done: res.stop_reason !== "tool_use" };
}

function emitUsage(
  onUsage: ((usage: UsageSnapshot) => void) | undefined,
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined,
): void {
  if (!onUsage || !usage) return;
  const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  onUsage({
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
  });
}

function mapRetry(onRetry: RunToolsArgs["onRetry"]) {
  return onRetry
    ? (event: { attempt: number; maxAttempts: number; reason: string }) =>
      onRetry({ attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.reason })
    : undefined;
}
