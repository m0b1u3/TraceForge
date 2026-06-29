import type { LlmProvider, TurnMessage, ToolCall } from "./provider.js";
import type { ToolRegistry } from "./registry.js";
import type { ApprovalGate } from "./approval-gate.js";

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "tool_rejected" | "text" | "done";
  name?: string;
  content: string;
}

const MAX_TURNS = 25;

export class AgentRuntime {
  constructor(private provider: LlmProvider, private registry: ToolRegistry, private gate: ApprovalGate) {}

  async run(
    system: string,
    initial: string | { role: "user" | "assistant"; content: string }[],
    onEvent: (e: AgentEvent) => void,
  ): Promise<void> {
    const messages: TurnMessage[] = typeof initial === "string"
      ? [{ role: "user", content: initial }]
      : initial.map((m) => ({ role: m.role, content: m.content }));

    for (let turnCount = 0; turnCount < MAX_TURNS; turnCount++) {
      const turn = await this.provider.runTools({ system, messages, tools: this.registry.toLlmTools() });
      if (turn.text) onEvent({ type: "text", content: turn.text });

      if (turn.toolCalls.length === 0 || turn.done) {
        onEvent({ type: "done", content: turn.text });
        return;
      }

      // 记录 assistant 这一轮（含 tool_calls），LLM 自主决定了调哪些工具
      messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });

      for (const call of turn.toolCalls) {
        const result = await this.runOneTool(call, onEvent);
        messages.push({ role: "tool", content: result, toolCallId: call.id });
      }
    }
    onEvent({ type: "done", content: "max turns reached" });
  }

  private async runOneTool(call: ToolCall, onEvent: (e: AgentEvent) => void): Promise<string> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const msg = `unknown tool: ${call.name}`;
      onEvent({ type: "tool_result", name: call.name, content: msg });
      return msg;
    }
    onEvent({ type: "tool_call", name: call.name, content: JSON.stringify(call.input) });

    const decision = await this.gate.check(tool, call.input);
    if (decision === "rejected") {
      onEvent({ type: "tool_rejected", name: call.name, content: "human rejected" });
      return "用户拒绝执行此动作。";
    }

    const res = await tool.execute(call.input);
    onEvent({ type: "tool_result", name: call.name, content: res.content });
    return res.content;
  }
}
