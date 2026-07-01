import { randomUUID } from "node:crypto";
import type { LlmProvider, TurnMessage, ToolCall } from "./provider.js";
import type { ToolRegistry } from "./registry.js";
import type { ApprovalGate } from "./approval-gate.js";

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "tool_rejected" | "text" | "done" |
    "stream_start" | "stream_delta" | "stream_end" | "interrupted" | "retrying";
  name?: string;
  messageId?: string;
  attempt?: number;
  maxAttempts?: number;
  content: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  runId?: string;
  getSteeringMessages?: () => string[];
}

const MAX_TURNS = 25;

interface ToolCallBatch {
  parallel: boolean;
  calls: ToolCall[];
}

export class AgentRuntime {
  constructor(private provider: LlmProvider, private registry: ToolRegistry, private gate: ApprovalGate) {}

  async run(
    system: string,
    initial: string | { role: "user" | "assistant"; content: string }[],
    onEvent: (e: AgentEvent) => void,
    options: AgentRunOptions = {},
  ): Promise<void> {
    const messages: TurnMessage[] = typeof initial === "string"
      ? [{ role: "user", content: initial }]
      : initial.map((m) => ({ role: m.role, content: m.content }));

    for (let turnCount = 0; turnCount < MAX_TURNS; turnCount++) {
      if (this.interrupted(options)) {
        this.emitInterrupted(onEvent);
        return;
      }

      const messageId = `msg_${randomUUID()}`;
      let streamed = "";
      onEvent({ type: "stream_start", messageId, content: "" });
      const turn = this.provider.streamTools
        ? await this.provider.streamTools(
          { system, messages, tools: this.registry.toLlmTools() },
          {
            signal: options.signal,
            onRetry: (event) => this.emitRetrying(event, onEvent),
            onTextDelta: (delta) => {
              streamed += delta;
              onEvent({ type: "stream_delta", messageId, content: delta });
            },
          },
        )
        : await this.provider.runTools({
          system,
          messages,
          tools: this.registry.toLlmTools(),
          onRetry: (event) => this.emitRetrying(event, onEvent),
        });
      if (!this.provider.streamTools && turn.text) {
        streamed += turn.text;
        onEvent({ type: "stream_delta", messageId, content: turn.text });
      }
      onEvent({ type: "stream_end", messageId, content: streamed || turn.text });
      if (this.interrupted(options)) {
        this.emitInterrupted(onEvent);
        return;
      }
      if (turn.text) onEvent({ type: "text", content: turn.text });

      if (turn.toolCalls.length === 0 || turn.done) {
        onEvent({ type: "done", content: turn.text });
        return;
      }

      // 记录 assistant 这一轮（含 tool_calls），LLM 自主决定了调哪些工具
      messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });

      for (const batch of this.groupToolCalls(turn.toolCalls)) {
        if (this.interrupted(options)) {
          this.emitInterrupted(onEvent);
          return;
        }
        const results = batch.parallel
          ? await Promise.all(batch.calls.map((call) => this.runOneTool(call, onEvent, { deferResultEvent: true })))
          : [await this.runOneTool(batch.calls[0], onEvent, { deferResultEvent: true })];
        for (let i = 0; i < batch.calls.length; i++) {
          const call = batch.calls[i];
          const result = results[i];
          onEvent({ type: "tool_result", name: call.name, content: result });
          messages.push({ role: "tool", content: result, toolCallId: call.id });
        }
        if (this.interrupted(options)) {
          this.emitInterrupted(onEvent);
          return;
        }
      }

      const steering = options.getSteeringMessages?.() ?? [];
      for (const text of steering) {
        messages.push({ role: "user", content: `[Human steering]\n用户运行中补充指令：${text}` });
      }
    }
    onEvent({ type: "done", content: "max turns reached" });
  }

  private interrupted(options?: AgentRunOptions): boolean {
    return options?.signal?.aborted === true;
  }

  private emitInterrupted(onEvent: (e: AgentEvent) => void): void {
    onEvent({ type: "interrupted", content: "agent run interrupted" });
  }

  private emitRetrying(
    event: { attempt: number; maxAttempts: number; reason: string },
    onEvent: (e: AgentEvent) => void,
  ): void {
    onEvent({ type: "retrying", content: event.reason, attempt: event.attempt, maxAttempts: event.maxAttempts });
  }

  private groupToolCalls(calls: ToolCall[]): ToolCallBatch[] {
    const batches: ToolCallBatch[] = [];
    let parallelCalls: ToolCall[] = [];
    const flushParallel = () => {
      if (parallelCalls.length > 0) {
        batches.push({ parallel: true, calls: parallelCalls });
        parallelCalls = [];
      }
    };

    for (const call of calls) {
      if (this.isParallelSafe(call)) {
        parallelCalls.push(call);
      } else {
        flushParallel();
        batches.push({ parallel: false, calls: [call] });
      }
    }
    flushParallel();
    return batches;
  }

  private isParallelSafe(call: ToolCall): boolean {
    const tool = this.registry.get(call.name);
    return tool?.risk !== "command" && tool?.executionMode === "parallel";
  }

  private async runOneTool(
    call: ToolCall,
    onEvent: (e: AgentEvent) => void,
    opts: { deferResultEvent?: boolean } = {},
  ): Promise<string> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const msg = `unknown tool: ${call.name}`;
      if (!opts.deferResultEvent) onEvent({ type: "tool_result", name: call.name, content: msg });
      return msg;
    }
    onEvent({ type: "tool_call", name: call.name, content: JSON.stringify(call.input) });

    const decision = await this.gate.check(tool, call.input);
    if (decision === "rejected") {
      onEvent({ type: "tool_rejected", name: call.name, content: "human rejected" });
      return "用户拒绝执行此动作。";
    }

    try {
      const res = await tool.execute(call.input);
      if (!opts.deferResultEvent) onEvent({ type: "tool_result", name: call.name, content: res.content });
      return res.content;
    } catch (error) {
      const content = `[tool_error] ${call.name}: ${(error as Error).message}`;
      if (!opts.deferResultEvent) onEvent({ type: "tool_result", name: call.name, content });
      return content;
    }
  }
}
