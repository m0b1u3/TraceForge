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
  useStore.setState({ caseId: null, agentEvents: [], activeRun: null, agentBusy: false, streamingMessages: {} });
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
      startedAt: "t", finishedAt: null, interruptReason: null, completionReason: null, error: null,
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
      startedAt: "t", finishedAt: "t2", interruptReason: "stop", completionReason: "stop", error: null,
    } });
    expect(useStore.getState().activeRun).toBeNull();
  });

  it("clears busy state and records a done event when an agent run needs continuation", () => {
    useStore.getState().setCase("case_1");
    useStore.setState({
      activeRun: {
        id: "run_1",
        caseId: "case_1",
        goal: "go",
        status: "running",
        createdAt: "t",
        startedAt: "t",
        finishedAt: null,
        interruptReason: null,
        completionReason: null,
        error: null,
      },
      agentBusy: true,
      agentEvents: [],
    });

    useStore.getState().handleRuntimeEvent({
      type: "agent_run_needs_continuation",
      reason: "run budget exhausted after 1 turns",
      run: {
        id: "run_1",
        caseId: "case_1",
        goal: "go",
        status: "needs_continuation",
        createdAt: "t",
        startedAt: "t",
        finishedAt: "t2",
        interruptReason: null,
        completionReason: "run budget exhausted after 1 turns",
        error: null,
      },
    });

    expect(useStore.getState().agentBusy).toBe(false);
    expect(useStore.getState().activeRun).toBeNull();
    expect(useStore.getState().agentEvents.at(-1)).toEqual({
      kind: "done",
      text: "Agent 已到达本次运行预算，需要继续运行。",
    });
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

  it("upserts observer warning updates from runtime events", () => {
    useStore.getState().setCase("case_1");
    useStore.setState({
      warnings: [{
        id: "warn_1",
        caseId: "case_1",
        level: "warning",
        title: "过早结束",
        description: "还有点没测",
        relatedFacts: [],
        relatedTasks: [],
        suggestedAction: "继续测 X",
        status: "open",
        relatedRunId: "run_1",
        suggestedGoal: "[Observer correction]\n继续测 X",
        resolvedAt: null,
        createdAt: "t1",
      }],
    });

    useStore.getState().handleRuntimeEvent({
      type: "observer_warning_updated",
      warning: {
        id: "warn_1",
        caseId: "case_1",
        level: "warning",
        title: "过早结束",
        description: "还有点没测",
        relatedFacts: [],
        relatedTasks: [],
        suggestedAction: "继续测 X",
        status: "accepted",
        relatedRunId: "run_1",
        suggestedGoal: "[Observer correction]\n继续测 X",
        resolvedAt: "t2",
        createdAt: "t1",
      },
    });

    expect(useStore.getState().warnings).toHaveLength(1);
    expect(useStore.getState().warnings[0].status).toBe("accepted");
    expect(useStore.getState().warnings[0].resolvedAt).toBe("t2");
  });
});
