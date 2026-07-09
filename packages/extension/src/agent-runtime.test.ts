import { describe, it, expect } from "vitest";
import { AgentRuntime, classifyToolFailure } from "./agent-runtime.js";
import { ToolRegistry } from "./registry.js";
import { ApprovalGate } from "./approval-gate.js";
import type { ToolDescriptor } from "./tool.js";
import type { AgentEvent, TurnSummary } from "./agent-runtime.js";
import type { LlmProvider, RunTurn, RunToolsArgs } from "./provider.js";
import { FailureMemory } from "./failure-memory.js";

class SeqProvider implements LlmProvider {
  private i = 0;
  constructor(private turns: RunTurn[], private usagePerTurn: number[] = []) {}
  async extractJson() { return {}; }
  async runTools(a: RunToolsArgs): Promise<RunTurn> {
    const turn = this.turns[this.i++] ?? { text: "", toolCalls: [], done: true };
    const usage = this.usagePerTurn[this.i - 1] ?? 0;
    if (usage > 0) a.onUsage?.({ promptTokens: usage, completionTokens: usage, totalTokens: usage * 2 });
    return turn;
  }
}

function replayTool(executed: string[]): ToolDescriptor {
  return {
    name: "http_replay", description: "replay", inputSchema: {}, risk: "normal", source: "builtin",
    execute: async (input) => { executed.push(JSON.stringify(input)); return { ok: true, content: "status=200" }; },
  };
}

const autoGate = new ApprovalGate(async () => "approved");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AgentRuntime", () => {
  it("executes a tool the LLM calls, feeds result back, ends on done", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(replayTool(executed));
    const provider = new SeqProvider([
      { text: "I'll replay", toolCalls: [{ id: "c1", name: "http_replay", input: { url: "https://t/x" } }], done: false },
      { text: "all done", toolCalls: [], done: true },
    ]);
    const events: string[] = [];
    await new AgentRuntime(provider, registry, autoGate).run("sys", "test it", (e) => events.push(`${e.type}:${e.content}`));
    expect(executed).toEqual(['{"url":"https://t/x"}']);
    expect(events.some((e) => e.startsWith("tool_result:status=200"))).toBe(true);
    expect(events.some((e) => e.startsWith("done"))).toBe(true);
  });

  it("does not execute a command-risk tool when human rejects", async () => {
    const ran: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "sqlmap", description: "sqlmap", inputSchema: {}, risk: "command", source: "plugin:sqlmap",
      execute: async () => { ran.push("yes"); return { ok: true, content: "ran" }; },
    });
    const rejectGate = new ApprovalGate(async () => "rejected");
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "c1", name: "sqlmap", input: {} }], done: false },
      { text: "ok skip", toolCalls: [], done: true },
    ]);
    const events: string[] = [];
    await new AgentRuntime(provider, registry, rejectGate).run("sys", "go", (e) => events.push(e.type));
    expect(ran).toEqual([]); // 被拒，没执行
    expect(events).toContain("tool_rejected");
  });

  it("reports unknown tool without crashing", async () => {
    const registry = new ToolRegistry();
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "c1", name: "ghost", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const events: string[] = [];
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => events.push(`${e.type}:${e.content}`));
    expect(events.some((e) => e.includes("unknown tool"))).toBe(true);
  });

  it("accepts pre-assembled messages array as initial context", async () => {
    let seen: { content: string }[] = [];
    const provider = new SeqProvider([{ text: "ok", toolCalls: [], done: true }]);
    const capturingProvider: LlmProvider = {
      extractJson: async () => ({}),
      runTools: async (a: RunToolsArgs) => {
        seen = a.messages;
        return { text: "ok", toolCalls: [], done: true };
      },
    };
    const registry = new ToolRegistry();
    await new AgentRuntime(capturingProvider, registry, autoGate).run(
      "sys",
      [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
      () => {},
    );
    expect(seen.map((m) => m.content)).toEqual(["a", "b", "c"]);
  });

  it("emits stream events through fallback runTools when provider has no streamTools", async () => {
    const provider = {
      runTools: async () => ({ text: "hello", toolCalls: [], done: true }),
      extractJson: async () => ({}),
    };
    const events: AgentEvent[] = [];
    await new AgentRuntime(provider, new ToolRegistry(), new ApprovalGate(async () => "approved"))
      .run("sys", "goal", (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(["stream_start", "stream_delta", "stream_end", "usage", "text", "done"]);
    expect(events.find((e) => e.type === "stream_delta")?.content).toBe("hello");
    expect(events.find((e) => e.type === "usage")?.cumulativeTotalTokens).toBe(0);
  });

  it("emits retrying events from provider retry callbacks", async () => {
    const provider: LlmProvider = {
      extractJson: async () => ({}),
      runTools: async (args) => {
        args.onRetry?.({ attempt: 2, maxAttempts: 3, reason: "rate limited" });
        return { text: "ok", toolCalls: [], done: true };
      },
    };
    const events: string[] = [];
    await new AgentRuntime(provider, new ToolRegistry(), new ApprovalGate(async () => "approved"))
      .run("sys", "go", (e) => events.push(`${e.type}:${e.content}`));
    expect(events).toContain("retrying:rate limited");
  });

  it("returns tool execution exceptions to the LLM as tool_result", async () => {
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "t1", name: "boom", input: {} }], done: false },
      { text: "handled", toolCalls: [], done: true },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: "boom", description: "boom", inputSchema: {}, risk: "normal", source: "test",
      execute: async () => { throw new Error("tool exploded"); },
    });
    const events: string[] = [];
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => events.push(`${e.type}:${e.content}`));
    expect(events).toContain("tool_result:[tool_error] boom: tool exploded");
    expect(events).toContain("done:handled");
  });

  it("runs contiguous parallel-safe tools concurrently", async () => {
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "a", name: "read_a", input: {} }, { id: "b", name: "read_b", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "read_a", description: "read", inputSchema: {}, risk: "normal", source: "test", executionMode: "parallel", execute: async () => { await sleep(50); return { ok: true, content: "A" }; } });
    registry.register({ name: "read_b", description: "read", inputSchema: {}, risk: "normal", source: "test", executionMode: "parallel", execute: async () => { await sleep(50); return { ok: true, content: "B" }; } });
    const started = Date.now();
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", () => {});
    expect(Date.now() - started).toBeLessThan(90);
  });

  it("emits parallel tool results in original tool call order", async () => {
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "a", name: "slow", input: {} }, { id: "b", name: "fast", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "slow", description: "slow", inputSchema: {}, risk: "normal", source: "test", executionMode: "parallel", execute: async () => { await sleep(40); return { ok: true, content: "A" }; } });
    registry.register({ name: "fast", description: "fast", inputSchema: {}, risk: "normal", source: "test", executionMode: "parallel", execute: async () => { await sleep(5); return { ok: true, content: "B" }; } });
    const results: string[] = [];
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => {
      if (e.type === "tool_result") results.push(e.content);
    });
    expect(results.slice(0, 2)).toEqual(["A", "B"]);
  });

  it("keeps serial tools sequential", async () => {
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "a", name: "write_a", input: {} }, { id: "b", name: "write_b", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "write_a", description: "write", inputSchema: {}, risk: "normal", source: "test", execute: async () => { await sleep(30); return { ok: true, content: "A" }; } });
    registry.register({ name: "write_b", description: "write", inputSchema: {}, risk: "normal", source: "test", execute: async () => { await sleep(30); return { ok: true, content: "B" }; } });
    const started = Date.now();
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", () => {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("keeps command-risk tools sequential even when marked parallel", async () => {
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "a", name: "cmd_a", input: {} }, { id: "b", name: "cmd_b", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "cmd_a", description: "cmd", inputSchema: {}, risk: "command", source: "test", executionMode: "parallel", execute: async () => { await sleep(30); return { ok: true, content: "A" }; } });
    registry.register({ name: "cmd_b", description: "cmd", inputSchema: {}, risk: "command", source: "test", executionMode: "parallel", execute: async () => { await sleep(30); return { ok: true, content: "B" }; } });
    let approvals = 0;
    const started = Date.now();
    await new AgentRuntime(provider, registry, new ApprovalGate(async () => { approvals += 1; return "approved"; })).run("sys", "go", () => {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(approvals).toBe(2);
  });

  it("keeps ordered tool_error results inside a parallel batch", async () => {
    const provider = new SeqProvider([
      { text: "", toolCalls: [{ id: "a", name: "bad", input: {} }, { id: "b", name: "good", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "bad", description: "bad", inputSchema: {}, risk: "normal", source: "test", executionMode: "parallel", execute: async () => { await sleep(20); throw new Error("bad exploded"); } });
    registry.register({ name: "good", description: "good", inputSchema: {}, risk: "normal", source: "test", executionMode: "parallel", execute: async () => ({ ok: true, content: "good ok" }) });
    const results: string[] = [];
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => {
      if (e.type === "tool_result") results.push(e.content);
    });
    expect(results.slice(0, 2)).toEqual(["[tool_error] bad: bad exploded", "good ok"]);
  });

  it("injects soft steering messages after tool results", async () => {
    const seen: string[][] = [];
    const provider = {
      extractJson: async () => ({}),
      runTools: async ({ messages }: RunToolsArgs) => {
        seen.push(messages.map((m) => m.content));
        if (seen.length === 1) {
          return { text: "need tool", toolCalls: [{ id: "tc_1", name: "read", input: {} }], done: false };
        }
        return { text: "steered", toolCalls: [], done: true };
      },
    };
    const registry = new ToolRegistry();
    registry.register({ name: "read", description: "read", inputSchema: { type: "object" }, risk: "normal", source: "test", execute: async () => ({ ok: true, content: "read ok" }) });
    await new AgentRuntime(provider, registry, new ApprovalGate(async () => "approved"))
      .run("sys", "goal", () => {}, { getSteeringMessages: () => ["look at orders"] });
    expect(seen[1].some((m) => m.includes("[Human steering]") && m.includes("look at orders"))).toBe(true);
  });

  it("emits budget_exhausted instead of done when maxTurns is reached", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "read", description: "read", inputSchema: { type: "object" }, risk: "normal", source: "test", execute: async () => ({ ok: true, content: "read ok" }) });
    const provider = new SeqProvider([
      { text: "need tool", toolCalls: [{ id: "tc_1", name: "read", input: {} }], done: false },
      { text: "need tool", toolCalls: [{ id: "tc_2", name: "read", input: {} }], done: false },
    ]);
    const events: AgentEvent[] = [];

    await new AgentRuntime(provider, registry, autoGate)
      .run("sys", "goal", (e) => events.push(e), { budget: { maxTurns: 2, warningTurnsRemaining: 0 } });

    expect(events.some((e) => e.type === "budget_exhausted")).toBe(true);
    expect(events).not.toContainEqual({ type: "done", content: "max turns reached" });
  });

  it("emits one budget_warning when the warning threshold is reached", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "read", description: "read", inputSchema: { type: "object" }, risk: "normal", source: "test", execute: async () => ({ ok: true, content: "read ok" }) });
    const provider = new SeqProvider([
      { text: "need tool", toolCalls: [{ id: "tc_1", name: "read", input: {} }], done: false },
      { text: "need tool", toolCalls: [{ id: "tc_2", name: "read", input: {} }], done: false },
      { text: "need tool", toolCalls: [{ id: "tc_3", name: "read", input: {} }], done: false },
    ]);
    const events: AgentEvent[] = [];

    await new AgentRuntime(provider, registry, autoGate)
      .run("sys", "goal", (e) => events.push(e), { budget: { maxTurns: 3, warningTurnsRemaining: 2 } });

    const warnings = events.filter((e) => e.type === "budget_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].content).toContain("2");
  });

  it("injects the run budget notice before the provider call on the warning turn", async () => {
    const seen: string[][] = [];
    const provider: LlmProvider = {
      extractJson: async () => ({}),
      runTools: async ({ messages }: RunToolsArgs) => {
        seen.push(messages.map((m) => m.content));
        return { text: "need tool", toolCalls: [{ id: `tc_${seen.length}`, name: "read", input: {} }], done: false };
      },
    };
    const registry = new ToolRegistry();
    registry.register({ name: "read", description: "read", inputSchema: { type: "object" }, risk: "normal", source: "test", execute: async () => ({ ok: true, content: "read ok" }) });

    await new AgentRuntime(provider, registry, autoGate)
      .run("sys", "goal", () => {}, { budget: { maxTurns: 2, warningTurnsRemaining: 1 } });

    expect(seen[1].some((m) => m.includes("[Run budget notice]"))).toBe(true);
    expect(seen[1].some((m) => m.includes("本次运行即将到达预算上限"))).toBe(true);
  });

  it("does not emit budget_exhausted when the model completes before the budget is spent", async () => {
    const provider = new SeqProvider([{ text: "done", toolCalls: [], done: true }]);
    const events: AgentEvent[] = [];

    await new AgentRuntime(provider, new ToolRegistry(), autoGate)
      .run("sys", "goal", (e) => events.push(e), { budget: { maxTurns: 2, warningTurnsRemaining: 1 } });

    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "budget_exhausted")).toBe(false);
  });

  it("keeps interruption terminal when interrupt is requested before exhaustion", async () => {
    const ac = new AbortController();
    ac.abort("stop");
    const provider = {
      extractJson: async () => ({}),
      runTools: async () => { throw new Error("should not call provider"); },
    };
    const events: AgentEvent[] = [];

    await new AgentRuntime(provider, new ToolRegistry(), autoGate)
      .run("sys", "goal", (e) => events.push(e), { signal: ac.signal, budget: { maxTurns: 1, warningTurnsRemaining: 0 } });

    expect(events.some((e) => e.type === "interrupted")).toBe(true);
    expect(events.some((e) => e.type === "budget_exhausted")).toBe(false);
  });

  it("calls onTurnComplete after each turn", async () => {
    const summaries: { runId: string; turnCount: number }[] = [];
    const provider = new SeqProvider([
      { text: "need tool", toolCalls: [{ id: "tc_1", name: "read", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "read", description: "read", inputSchema: { type: "object" }, risk: "normal", source: "test", execute: async () => ({ ok: true, content: "read ok" }) });
    await new AgentRuntime(provider, registry, autoGate)
      .run("sys", "goal", () => {}, {
        runId: "r1",
        onTurnComplete: async (summary) => { summaries.push({ runId: summary.runId, turnCount: summary.turnCount }); return { action: "continue" }; },
      });
    expect(summaries).toEqual([{ runId: "r1", turnCount: 0 }]);
  });

  it("pauses the run when onTurnComplete returns pause", async () => {
    const summaries: TurnSummary[] = [];
    const provider = new SeqProvider([
      { text: "need tool", toolCalls: [{ id: "tc_1", name: "read", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "read", description: "read", inputSchema: { type: "object" }, risk: "normal", source: "test", execute: async () => ({ ok: true, content: "read ok" }) });
    const events: AgentEvent[] = [];
    await new AgentRuntime(provider, registry, autoGate)
      .run("sys", "goal", (e) => events.push(e), {
        runId: "r1",
        onTurnComplete: async (summary) => {
          summaries.push(summary);
          return { action: "pause", reason: "critical warning" };
        },
      });
    expect(summaries).toHaveLength(1);
    expect(events.some((e) => e.type === "interrupted")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("runs until the model completes when no budget is set", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "read", description: "read", inputSchema: { type: "object" }, risk: "normal", source: "test", execute: async () => ({ ok: true, content: "read ok" }) });
    const turns: RunTurn[] = Array.from({ length: 30 }, (_, i) => ({
      text: `turn ${i}`,
      toolCalls: [{ id: `tc_${i}`, name: "read", input: {} }],
      done: false,
    }));
    turns.push({ text: "all done", toolCalls: [], done: true });
    const provider = new SeqProvider(turns);
    const events: AgentEvent[] = [];

    await new AgentRuntime(provider, registry, autoGate).run("sys", "goal", (e) => events.push(e));

    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "budget_exhausted")).toBe(false);
  });

  it("emits cumulative usage events when the provider reports usage", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "read", description: "read", inputSchema: { type: "object" }, risk: "normal", source: "test", execute: async () => ({ ok: true, content: "read ok" }) });
    const provider = new SeqProvider([
      { text: "need tool", toolCalls: [{ id: "tc_1", name: "read", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ], [3, 5]);
    const events: AgentEvent[] = [];

    await new AgentRuntime(provider, registry, autoGate).run("sys", "goal", (e) => events.push(e));

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0].totalTokens).toBe(6);
    expect(usageEvents[0].cumulativeTotalTokens).toBe(6);
    expect(usageEvents[1].totalTokens).toBe(10);
    expect(usageEvents[1].cumulativeTotalTokens).toBe(16);
  });
});

describe("AgentRuntime failure memory", () => {
  it("classifies tool failures by retry policy", () => {
    expect(classifyToolFailure("HTTP 429 Too Many Requests")).toBe("transient");
    expect(classifyToolFailure("download failed: HTTP 503")).toBe("transient");
    expect(classifyToolFailure("out of scope: host is not allowed")).toBe("policy");
    expect(classifyToolFailure("浏览器未启动")).toBe("environment");
    expect(classifyToolFailure("unknown mcp server: poc")).toBe("environment");
    expect(classifyToolFailure("sh: nuclei: command not found")).toBe("permanent");
  });

  it("emits tool_blocked when retrying an identical failed call", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "failing", description: "failing", inputSchema: { type: "object" },
      risk: "normal", source: "test",
      execute: async () => ({ ok: false, content: "err" }),
    });
    const provider = new SeqProvider([
      { text: "call", toolCalls: [{ id: "c1", name: "failing", input: { x: 1 } }], done: false },
      { text: "retry", toolCalls: [{ id: "c2", name: "failing", input: { x: 1 } }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const events: AgentEvent[] = [];
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => events.push(e), { failureMemory: new FailureMemory() });
    expect(events.some((e) => e.type === "tool_blocked")).toBe(true);
  });

  it("skips a second identical failing tool call within a run", async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "failing", description: "failing", inputSchema: { type: "object" },
      risk: "normal", source: "test",
      execute: async () => { calls += 1; return { ok: false, content: "boom" }; },
    });
    const provider = new SeqProvider([
      { text: "call", toolCalls: [{ id: "c1", name: "failing", input: { x: 1 } }], done: false },
      { text: "retry", toolCalls: [{ id: "c2", name: "failing", input: { x: 1 } }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const events: string[] = [];
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => events.push(`${e.type}:${e.content}`), { failureMemory: new FailureMemory() });
    expect(calls).toBe(1);
    expect(events.some((s) => s.includes("tool_blocked"))).toBe(true);
  });

  it("does not remember timeout results as permanent failed calls", async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "flaky", description: "flaky", inputSchema: { type: "object" },
      risk: "normal", source: "test",
      execute: async () => {
        calls += 1;
        return { ok: false, content: "exit=timeout(1000ms)\n--- stdout ---\n\n--- stderr ---\n" };
      },
    });
    const provider = new SeqProvider([
      { text: "call", toolCalls: [{ id: "c1", name: "flaky", input: { x: 1 } }], done: false },
      { text: "retry", toolCalls: [{ id: "c2", name: "flaky", input: { x: 1 } }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const events: AgentEvent[] = [];

    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => events.push(e), { failureMemory: new FailureMemory() });

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "tool_blocked")).toBe(false);
  });

  it("allows the same command after a workspace-changing tool succeeds", async () => {
    let commandCalls = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "exec_command", description: "exec", inputSchema: { type: "object" },
      risk: "command", source: "test",
      execute: async () => { commandCalls += 1; return { ok: false, content: "exit=1\nscript failed" }; },
    });
    registry.register({
      name: "write_file", description: "write", inputSchema: { type: "object" },
      risk: "command", source: "test",
      execute: async () => ({ ok: true, content: "wrote exploit.py" }),
    });
    const commandInput = { command: "python exploit.py" };
    const provider = new SeqProvider([
      { text: "run script", toolCalls: [{ id: "c1", name: "exec_command", input: commandInput }], done: false },
      { text: "fix script", toolCalls: [{ id: "c2", name: "write_file", input: { path: "exploit.py", content: "fixed" } }], done: false },
      { text: "rerun script", toolCalls: [{ id: "c3", name: "exec_command", input: commandInput }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    const events: AgentEvent[] = [];

    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => events.push(e), { failureMemory: new FailureMemory() });

    expect(commandCalls).toBe(2);
    expect(events.some((e) => e.type === "tool_blocked")).toBe(false);
  });

  it("does not block a call that succeeded", async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "ok", description: "ok", inputSchema: { type: "object" },
      risk: "normal", source: "test",
      execute: async () => { calls += 1; return { ok: true, content: "ok" }; },
    });
    const provider = new SeqProvider([
      { text: "call", toolCalls: [{ id: "c1", name: "ok", input: {} }], done: false },
      { text: "call", toolCalls: [{ id: "c2", name: "ok", input: {} }], done: false },
      { text: "done", toolCalls: [], done: true },
    ]);
    await new AgentRuntime(provider, registry, autoGate).run("sys", "go", () => {}, { failureMemory: new FailureMemory() });
    expect(calls).toBe(2);
  });
});
