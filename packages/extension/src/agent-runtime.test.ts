import { describe, it, expect } from "vitest";
import { AgentRuntime } from "./agent-runtime.js";
import { ToolRegistry } from "./registry.js";
import { ApprovalGate } from "./approval-gate.js";
import type { ToolDescriptor } from "./tool.js";
import type { AgentEvent } from "./agent-runtime.js";
import type { LlmProvider, RunTurn, RunToolsArgs } from "./provider.js";

class SeqProvider implements LlmProvider {
  private i = 0;
  constructor(private turns: RunTurn[]) {}
  async extractJson() { return {}; }
  async runTools(_a: RunToolsArgs): Promise<RunTurn> { return this.turns[this.i++] ?? { text: "", toolCalls: [], done: true }; }
}

function replayTool(executed: string[]): ToolDescriptor {
  return {
    name: "http_replay", description: "replay", inputSchema: {}, risk: "normal", source: "builtin",
    execute: async (input) => { executed.push(JSON.stringify(input)); return { ok: true, content: "status=200" }; },
  };
}

const autoGate = new ApprovalGate(async () => "approved");

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
    expect(events.map((e) => e.type)).toEqual(["stream_start", "stream_delta", "stream_end", "text", "done"]);
    expect(events.find((e) => e.type === "stream_delta")?.content).toBe("hello");
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

  it("stops before the next turn when signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort("stop");
    const provider = {
      extractJson: async () => ({}),
      runTools: async () => { throw new Error("should not call provider"); },
    };
    const events: AgentEvent[] = [];
    await new AgentRuntime(provider, new ToolRegistry(), new ApprovalGate(async () => "approved"))
      .run("sys", "goal", (e) => events.push(e), { signal: ac.signal });
    expect(events.at(-1)?.type).toBe("interrupted");
  });
});
