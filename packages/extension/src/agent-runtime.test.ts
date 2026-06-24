import { describe, it, expect } from "vitest";
import { AgentRuntime } from "./agent-runtime.js";
import { ToolRegistry } from "./registry.js";
import { ApprovalGate } from "./approval-gate.js";
import type { ToolDescriptor } from "./tool.js";
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
});
