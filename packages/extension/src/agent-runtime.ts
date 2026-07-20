import { randomUUID } from "node:crypto";
import type { LlmProvider, TurnMessage, ToolCall, UsageSnapshot } from "./provider.js";
import type { ToolRegistry } from "./registry.js";
import type { ApprovalGate } from "./approval-gate.js";
import { FailureMemory } from "./failure-memory.js";

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "tool_rejected" | "tool_blocked" | "text" | "reasoning" | "done" |
    "stream_start" | "stream_delta" | "stream_end" | "interrupted" | "retrying" |
    "budget_warning" | "budget_exhausted" | "usage";
  name?: string;
  input?: string;
  messageId?: string;
  attempt?: number;
  maxAttempts?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cumulativePromptTokens?: number;
  cumulativeCompletionTokens?: number;
  cumulativeTotalTokens?: number;
  content: string;
}

export interface AgentRunBudget {
  maxTurns: number;
  warningTurnsRemaining: number;
}

export interface ToolExecutionReport {
  name: string;
  input: unknown;
  content: string;
  ok: boolean;
  risk?: "normal" | "command";
  rejected?: boolean;
  blocked?: boolean;
  transient?: boolean;
  failureClass?: ToolFailureClass;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  runId?: string;
  getSteeringMessages?: () => string[];
  budget?: Partial<AgentRunBudget>;
  onTurnComplete?: (summary: TurnSummary) => Promise<ObserverReviewDecision>;
  reviewIntervalTurns?: number;
  getObserverReviewTrigger?: () => ObserverReviewTrigger | null;
  toolTimeoutMs?: number;
  failureMemory?: FailureMemory;
  onToolExecuted?: (report: ToolExecutionReport) => void | Promise<void>;
}

export interface TurnSummary {
  runId: string;
  turnCount: number;
  trajectory: string;
  trigger: ObserverReviewTrigger;
}

export type ObserverReviewTrigger =
  | "interval"
  | "final"
  | "repeated_failure"
  | "high_risk"
  | "evidence_conflict"
  | "finding_verification";

export const DEFAULT_RUN_BUDGET: AgentRunBudget = {
  maxTurns: Infinity,
  warningTurnsRemaining: 0,
};

export function normalizeRunBudget(input?: Partial<AgentRunBudget>): AgentRunBudget {
  const rawMaxTurns = input?.maxTurns !== undefined ? input.maxTurns : DEFAULT_RUN_BUDGET.maxTurns;
  const maxTurns =
    typeof rawMaxTurns === "number" && Number.isFinite(rawMaxTurns) && rawMaxTurns > 0
      ? Math.floor(rawMaxTurns)
      : Infinity;

  const rawWarningTurnsRemaining =
    input?.warningTurnsRemaining !== undefined
      ? input.warningTurnsRemaining
      : DEFAULT_RUN_BUDGET.warningTurnsRemaining;
  const warningTurnsRemaining =
    typeof rawWarningTurnsRemaining === "number" && Number.isFinite(rawWarningTurnsRemaining) && rawWarningTurnsRemaining >= 0
      ? Math.floor(rawWarningTurnsRemaining)
      : 0;

  return {
    maxTurns,
    warningTurnsRemaining,
  };
}

export interface ObserverReviewDecision {
  action: "continue" | "pause";
  reason?: string;
  steering?: string[];
}

export function shouldReviewAtCheckpoint(turnCount: number, intervalTurns = 6): boolean {
  const interval = Math.max(1, Math.floor(intervalTurns));
  return turnCount > 0 && turnCount % interval === 0;
}

export function incrementalTrajectory(messages: TurnMessage[], reviewedMessageCount: number): string {
  return messages
    .slice(Math.max(0, reviewedMessageCount))
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}

export async function executeWithDeadline<T>(
  execute: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error("tool execution aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool execution timed out after ${timeoutMs}ms`)), timeoutMs);
    if (signal) {
      onAbort = () => reject(new Error("tool execution aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([execute(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

const RUN_BUDGET_NOTICE = `[Run budget notice]
本次运行即将到达预算上限。请优先判断：
1. 如果任务已经完成，直接总结并结束。
2. 如果任务未完成但有明确下一步，请说明下一步和为什么需要继续。
3. 如果缺少证据、权限、输入或外部条件，请记录 blocked task 或明确说明阻塞原因。
不要为了消耗轮次而继续调用无关工具。`;

export type ToolFailureClass = "permanent" | "transient" | "policy" | "environment";

export function classifyToolFailure(content: string): ToolFailureClass {
  const text = content.toLowerCase();
  if (
    text.includes("out of scope")
    || text.includes("scope guard")
    || text.includes("approval pending")
    || text.includes("user rejected")
    || text.includes("human control")
    || text.includes("handoff")
    || text.includes("not authorized")
  ) {
    return "policy";
  }
  if (
    text.includes("浏览器未启动")
    || text.includes("browser not started")
    || text.includes("no browser session")
    || text.includes("unknown mcp server")
    || text.includes("mcp call failed")
    || text.includes("mcp server")
    || text.includes("resource temporarily unavailable")
    || text.includes("spawn eagain")
    || text.includes("emfile")
    || text.includes("enomem")
    || text.includes("too many open files")
  ) {
    return "environment";
  }
  if (
    text.includes("timeout")
    || text.includes("timed out")
    || text.includes("etimedout")
    || text.includes("econnreset")
    || text.includes("econnrefused")
    || text.includes("enotfound")
    || text.includes("eai_again")
    || text.includes("network")
    || text.includes("socket hang up")
    || text.includes("temporary failure in name resolution")
    || text.includes("http 408")
    || text.includes("http 429")
    || text.includes("http 500")
    || text.includes("http 502")
    || text.includes("http 503")
    || text.includes("http 504")
    || text.includes("too many requests")
    || text.includes("rate limit")
    || text.includes("service unavailable")
    || text.includes("bad gateway")
    || text.includes("gateway timeout")
    || text.includes("empty reply from server")
  ) {
    return "transient";
  }
  return "permanent";
}

function changesWorkspace(toolName: string): boolean {
  return toolName === "download_tool"
    || toolName === "write_file"
    || toolName === "exec_command"
    || toolName.endsWith("__write_file")
    || toolName.endsWith("__exec_command");
}

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
    const budget = normalizeRunBudget(options.budget);
    const failureMemory = options.failureMemory ?? new FailureMemory();
    let warned = false;
    let turnCount = 0;
    let cumulativePromptTokens = 0;
    let cumulativeCompletionTokens = 0;
    let cumulativeTotalTokens = 0;
    let lastReviewedMessageIndex = 0;
    const budgetFinite = Number.isFinite(budget.maxTurns);
    const reviewIntervalTurns = Math.max(1, Math.floor(options.reviewIntervalTurns ?? 6));

    const review = async (trigger: TurnSummary["trigger"], count: number, extra?: TurnMessage) => {
      if (!options.onTurnComplete || !options.runId) return { action: "continue" as const };
      const trajectoryMessages = extra ? [...messages, extra] : messages;
      const decision = await options.onTurnComplete({
        runId: options.runId,
        turnCount: count,
        trajectory: incrementalTrajectory(trajectoryMessages, lastReviewedMessageIndex),
        trigger,
      });
      lastReviewedMessageIndex = trajectoryMessages.length;
      return decision;
    };

    const applyObserverSteering = (decision: ObserverReviewDecision): boolean => {
      const steering = decision.steering?.map((text) => text.trim()).filter(Boolean) ?? [];
      for (const text of steering) {
        messages.push({ role: "user", content: `[Observer correction]\n${text}` });
      }
      return steering.length > 0;
    };

    while (true) {
      if (this.interrupted(options)) {
        this.emitInterrupted(onEvent);
        return;
      }

      if (budgetFinite && turnCount >= budget.maxTurns) {
        onEvent({ type: "budget_exhausted", content: `run budget exhausted after ${budget.maxTurns} turns` });
        return;
      }

      const turnsRemaining = budgetFinite ? budget.maxTurns - turnCount : Infinity;
      if (budgetFinite && !warned && turnsRemaining <= budget.warningTurnsRemaining) {
        warned = true;
        onEvent({
          type: "budget_warning",
          content: `${turnsRemaining} turns remaining before run budget exhaustion`,
        });
        messages.push({ role: "user", content: RUN_BUDGET_NOTICE });
      }

      const messageId = `msg_${randomUUID()}`;
      let streamed = "";
      let turnPromptTokens = 0;
      let turnCompletionTokens = 0;
      let turnTotalTokens = 0;
      const onUsage = (u: UsageSnapshot) => {
        turnPromptTokens += u.promptTokens;
        turnCompletionTokens += u.completionTokens;
        turnTotalTokens += u.totalTokens;
      };
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
            onUsage,
          },
        )
        : await this.provider.runTools({
          system,
          messages,
          tools: this.registry.toLlmTools(),
          onRetry: (event) => this.emitRetrying(event, onEvent),
          onUsage,
        });
      if (!this.provider.streamTools && turn.text) {
        streamed += turn.text;
        onEvent({ type: "stream_delta", messageId, content: turn.text });
      }
      onEvent({ type: "stream_end", messageId, content: streamed || turn.text });

      cumulativePromptTokens += turnPromptTokens;
      cumulativeCompletionTokens += turnCompletionTokens;
      cumulativeTotalTokens += turnTotalTokens;
      onEvent({
        type: "usage",
        content: `Token usage: +${turnPromptTokens} prompt / +${turnCompletionTokens} completion / +${turnTotalTokens} total (cumulative ${cumulativeTotalTokens})`,
        promptTokens: turnPromptTokens,
        completionTokens: turnCompletionTokens,
        totalTokens: turnTotalTokens,
        cumulativePromptTokens,
        cumulativeCompletionTokens,
        cumulativeTotalTokens,
      });

      if (this.interrupted(options)) {
        this.emitInterrupted(onEvent);
        return;
      }
      if (turn.reasoning && turn.reasoning !== turn.text) onEvent({ type: "reasoning", content: turn.reasoning });
      if (turn.text) onEvent({ type: "text", content: turn.text });

      if (turn.toolCalls.length === 0 || turn.done) {
        const decision = await review("final", turnCount + 1, { role: "assistant", content: turn.text });
        if (decision.action === "pause") {
          onEvent({ type: "interrupted", content: decision.reason ?? "paused by observer" });
          return;
        }
        if (decision.steering?.some((text) => text.trim())) {
          messages.push({ role: "assistant", content: turn.text });
          applyObserverSteering(decision);
          turnCount += 1;
          continue;
        }
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
          ? await Promise.all(batch.calls.map((call) => this.runOneTool(call, onEvent, failureMemory, options, { deferResultEvent: true })))
          : [await this.runOneTool(batch.calls[0], onEvent, failureMemory, options, { deferResultEvent: true })];
        for (let i = 0; i < batch.calls.length; i++) {
          const call = batch.calls[i];
          const result = results[i];
          onEvent({ type: "tool_result", name: call.name, content: result.content });
          messages.push({ role: "tool", content: result.content, toolCallId: call.id });
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

      turnCount += 1;
      const eventTrigger = options.getObserverReviewTrigger?.() ?? null;
      if (eventTrigger || shouldReviewAtCheckpoint(turnCount, reviewIntervalTurns)) {
        const decision = await review(eventTrigger ?? "interval", turnCount);
        if (decision?.action === "pause") {
          onEvent({ type: "interrupted", content: decision.reason ?? "paused by observer" });
          return;
        }
        applyObserverSteering(decision);
      }
    }
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
    failureMemory: FailureMemory,
    options: AgentRunOptions,
    opts: { deferResultEvent?: boolean } = {},
  ): Promise<{ content: string; ok: boolean }> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const msg = `unknown tool: ${call.name}`;
      if (!opts.deferResultEvent) onEvent({ type: "tool_result", name: call.name, content: msg });
      const result = { content: msg, ok: false };
      if (options.onToolExecuted) {
        await options.onToolExecuted({ name: call.name, input: call.input, content: result.content, ok: result.ok });
      }
      return result;
    }

    if (failureMemory.has(call.name, call.input)) {
      const content = `[tool_blocked] ${call.name}: 该调用已在本运行中失败过，使用相同输入不会再次执行。请换用其他方法，或当本地环境无法解决时使用 download_tool 下载现成工具。`;
      onEvent({ type: "tool_blocked", name: call.name, input: JSON.stringify(call.input), content });
      const result = { content, ok: false };
      if (options.onToolExecuted) {
        await options.onToolExecuted({ name: call.name, input: call.input, content: result.content, ok: result.ok, blocked: true, risk: tool.risk });
      }
      return result;
    }

    onEvent({ type: "tool_call", name: call.name, content: JSON.stringify(call.input) });

    const decision = await this.gate.check(tool, call.input);
    if (decision === "rejected") {
      const content = "用户拒绝执行此动作。";
      onEvent({ type: "tool_rejected", name: call.name, content });
      const result = { content, ok: false };
      if (options.onToolExecuted) {
        await options.onToolExecuted({ name: call.name, input: call.input, content: result.content, ok: result.ok, rejected: true, risk: tool.risk });
      }
      return result;
    }

    try {
      const res = await executeWithDeadline(
        () => tool.execute(call.input),
        Math.max(1_000, options.toolTimeoutMs ?? 45_000),
        options.signal,
      );
      if (res.ok && changesWorkspace(call.name)) failureMemory.clear();
      const failureClass = res.ok ? undefined : classifyToolFailure(res.content);
      const transient = failureClass === "transient";
      if (!res.ok && failureClass === "permanent") failureMemory.add(call.name, call.input);
      if (!opts.deferResultEvent) onEvent({ type: "tool_result", name: call.name, content: res.content });
      const result = { content: res.content, ok: res.ok };
      if (options.onToolExecuted) {
        await options.onToolExecuted({ name: call.name, input: call.input, content: result.content, ok: result.ok, transient, failureClass, risk: tool.risk });
      }
      return result;
    } catch (error) {
      failureMemory.add(call.name, call.input);
      const content = `[tool_error] ${call.name}: ${(error as Error).message}`;
      if (!opts.deferResultEvent) onEvent({ type: "tool_result", name: call.name, content });
      const result = { content, ok: false };
      if (options.onToolExecuted) {
        await options.onToolExecuted({ name: call.name, input: call.input, content: result.content, ok: result.ok, risk: tool.risk });
      }
      return result;
    }
  }
}
