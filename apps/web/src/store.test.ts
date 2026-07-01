import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./api.js", () => ({
  listTraffic: vi.fn(async () => []),
  listFacts: vi.fn(async () => []),
  listTasks: vi.fn(async () => []),
  listTimeline: vi.fn(async () => []),
  listMcpTools: vi.fn(async () => []),
  listWarnings: vi.fn(async () => []),
  listAgentEvents: vi.fn(async () => [
    { id: "ae_1", caseId: "c1", kind: "started", text: "开始：找接口", tool: null, createdAt: "t1" },
    { id: "ae_2", caseId: "c1", kind: "tool_call", text: "record_fact(...)", tool: "record_fact", createdAt: "t2" },
  ]),
}));

import { useStore } from "./store.js";

beforeEach(() => {
  useStore.setState({ caseId: null, agentEvents: [], activeRun: null, streamingMessages: {} });
});

describe("enterCase agent history hydration", () => {
  it("fills agentEvents from the history endpoint as AgentUiEvents", async () => {
    await useStore.getState().enterCase("c1");
    const events = useStore.getState().agentEvents;
    expect(events.map((e) => e.kind)).toEqual(["started", "tool_call"]);
    expect(events[0].text).toBe("开始：找接口");
    expect(events[1].text).toContain("record_fact");
  });
});

describe("agent run control event handling", () => {
  it("tracks active run and concatenates streaming deltas", () => {
    const s = useStore.getState();
    s.setCase("case_1");
    useStore.getState().handleRuntimeEvent({ type: "agent_run_started", run: {
      id: "run_1", caseId: "case_1", goal: "go", status: "running", createdAt: "t",
      startedAt: "t", finishedAt: null, interruptReason: null, error: null,
    } });
    useStore.getState().handleRuntimeEvent({ type: "agent_stream_start", caseId: "case_1", runId: "run_1", messageId: "m1" });
    useStore.getState().handleRuntimeEvent({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "m1", delta: "hel" });
    useStore.getState().handleRuntimeEvent({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "m1", delta: "lo" });
    expect(useStore.getState().activeRun?.id).toBe("run_1");
    expect(useStore.getState().agentEvents.at(-1)?.text).toBe("hello");
  });

  it("records steering and clears active run on interruption", () => {
    useStore.getState().setCase("case_1");
    useStore.getState().handleRuntimeEvent({ type: "agent_steering_added", caseId: "case_1", runId: "run_1", content: "look at orders" });
    expect(useStore.getState().agentEvents.at(-1)?.kind).toBe("user");
    useStore.getState().handleRuntimeEvent({ type: "agent_run_interrupted", run: {
      id: "run_1", caseId: "case_1", goal: "go", status: "interrupted", createdAt: "t",
      startedAt: "t", finishedAt: "t2", interruptReason: "stop", error: null,
    } });
    expect(useStore.getState().activeRun).toBeNull();
  });

  it("records retrying events as agent status text", () => {
    useStore.getState().setCase("case_1");
    useStore.getState().handleRuntimeEvent({
      type: "agent_retrying",
      caseId: "case_1",
      runId: "run_1",
      attempt: 2,
      maxAttempts: 3,
      reason: "rate limited",
    });
    expect(useStore.getState().agentEvents.at(-1)).toEqual({
      kind: "text",
      text: "正在重试 LLM 调用 2/3：rate limited",
    });
  });
});
