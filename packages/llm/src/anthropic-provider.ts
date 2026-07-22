import Anthropic from "@anthropic-ai/sdk";
import { proxyFetch } from "@traceforge/shared/proxy";
import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, RunTurn, ToolCall, UsageSnapshot } from "./provider.js";
import { withRetry } from "./retry.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  constructor(private opts: AnthropicOptions) {
    const fetchImpl = proxyFetch();
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
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
    const res = await withRetry("anthropic.extractJson", () => this.client.messages.create(params));
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text block in response");
    emitUsage(args.onUsage, res.usage);
    return JSON.parse(text.text);
  }

  async runTools(args: RunToolsArgs): Promise<RunTurn> {
    // 用 Anthropic 原生 tool-calling：tools 参数 + tool_use/tool_result 块。
    // SDK 类型对 thinking:adaptive 不全，整体断言兜底（同 extractJson）。
    // Anthropic 协议：一条 assistant 里的 N 个 tool_use，必须紧跟"一条" user 消息且其中含全部 N 个
    // tool_result。AgentRuntime 把每个工具结果存为独立的 role:"tool" 消息，这里要把**连续的** tool
    // 消息合并进同一条 user 消息，否则 DeepSeek/Anthropic 端点报 "tool_use ids without tool_result"。
    const anthropicMessages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
    for (const m of args.messages) {
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
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: args.system,
      tools: args.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: anthropicMessages,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;
    const res = await withRetry("anthropic.runTools", () => this.client.messages.create(params), { onRetry: mapRetry(args.onRetry) });
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    emitUsage(args.onUsage, res.usage);
    return { text, toolCalls, done: res.stop_reason !== "tool_use" };
  }
}

function emitUsage(
  onUsage: ((usage: UsageSnapshot) => void) | undefined,
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
): void {
  if (!onUsage || !usage) return;
  const inputTokens = usage.input_tokens ?? 0;
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
