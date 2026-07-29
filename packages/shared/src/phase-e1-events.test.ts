import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "./events.js";

// 类型层断言：构造各 agent 事件不报类型错（编译即测试）
describe("agent runtime events", () => {
  it("accepts agent lifecycle and approval events", () => {
    const events: RuntimeEvent[] = [
      { type: "agent_started", caseId: "c", goal: "test it" },
      { type: "agent_text", caseId: "c", content: "thinking" },
      { type: "agent_tool_call", caseId: "c", runId: "run_1", executionId: "exec_1", tool: "http_replay", input: "{}" },
      { type: "agent_tool_result", caseId: "c", runId: "run_1", executionId: "exec_1", tool: "http_replay", content: "status=200", outcome: "succeeded", recoveredExecutionIds: [] },
      { type: "agent_done", caseId: "c", content: "finished" },
      { type: "agent_error", caseId: "c", content: "network error" },
      { type: "approval_requested", caseId: "c", approvalId: "a1", tool: "sqlmap", input: "{}" },
      { type: "approval_resolved", caseId: "c", approvalId: "a1", tool: "exec_command", decision: "approved" },
      { type: "scope_expansion_proposed", caseId: "c", host: "cdn.t.com", reason: "same cert" },
    ];
    expect(events).toHaveLength(9);
    expect(events[0].type).toBe("agent_started");
  });
});
