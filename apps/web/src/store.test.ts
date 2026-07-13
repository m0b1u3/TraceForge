import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./store.js";

function resetStore() {
  useStore.setState({
    caseId: "case_1",
    cases: [{ id: "case_1", name: "Case 1", status: "active", scopeRules: [], createdAt: "now" }],
    traffic: [{ id: "traffic_1", caseId: "case_1", url: "https://t.com", method: "GET", requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: null, createdAt: "now" }],
    facts: [],
    tasks: [],
    timeline: [],
    actions: [],
    decisions: [],
    pendingConfirmation: null,
    activeTab: "facts",
    agentEvents: [],
    activeRun: null,
    agentBusy: false,
    streamingMessages: {},
    streamedAgentTexts: [],
    toast: null,
    warnings: [],
    pendingApproval: null,
    pendingScope: null,
    browserController: null,
    browserUrl: "",
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
}

const warning = {
  id: "warn_1",
  caseId: "case_1",
  level: "critical" as const,
  title: "偏离目标",
  description: "一直在测无关接口",
  relatedFacts: [],
  relatedTasks: [],
  suggestedAction: "回到登录流程",
  suggestedGoal: "",
  status: "open" as const,
  relatedRunId: "run_1",
  resolvedAt: null,
  createdAt: new Date().toISOString(),
};

describe("store observer confirmation", () => {
  beforeEach(() => {
    resetStore();
  });

  it("sets pending confirmation and switches to observer tab on agent_run_needs_confirmation", () => {
    useStore.getState().handleRuntimeEvent({ type: "agent_run_needs_confirmation", caseId: "case_1", runId: "run_1", warning });
    expect(useStore.getState().pendingConfirmation).toEqual({ runId: "run_1", warning });
    expect(useStore.getState().activeTab).toBe("observer");
    expect(useStore.getState().agentEvents.at(-1)?.text).toContain("偏离目标");
    expect(useStore.getState().toast).toContain("偏离目标");
  });

  it("ignores confirmation events for other cases", () => {
    useStore.getState().handleRuntimeEvent({ type: "agent_run_needs_confirmation", caseId: "case_2", runId: "run_1", warning });
    expect(useStore.getState().pendingConfirmation).toBeNull();
    expect(useStore.getState().activeTab).toBe("facts");
  });

  it("clears the current case when a delete event arrives over websocket", () => {
    useStore.getState().handleRuntimeEvent({ type: "case_deleted", caseId: "case_1" });

    expect(useStore.getState().caseId).toBeNull();
    expect(useStore.getState().traffic).toEqual([]);
  });
});

describe("store token usage", () => {
  beforeEach(() => {
    resetStore();
  });

  it("resets token usage when a run starts", () => {
    useStore.setState({
      tokenUsage: { promptTokens: 99, completionTokens: 99, totalTokens: 99 },
    });
    useStore.getState().handleRuntimeEvent({
      type: "agent_run_started",
      run: {
        id: "run_1",
        caseId: "case_1",
        goal: "test",
        status: "running",
        createdAt: "now",
        startedAt: "now",
        finishedAt: null,
        interruptReason: null,
        completionReason: null,
        error: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    });
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("updates cumulative token usage on agent_usage events", () => {
    useStore.getState().handleRuntimeEvent({
      type: "agent_usage",
      caseId: "case_1",
      runId: "run_1",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cumulativePromptTokens: 10,
      cumulativeCompletionTokens: 5,
      cumulativeTotalTokens: 15,
    });
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    useStore.getState().handleRuntimeEvent({
      type: "agent_usage",
      caseId: "case_1",
      runId: "run_1",
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      cumulativePromptTokens: 13,
      cumulativeCompletionTokens: 7,
      cumulativeTotalTokens: 20,
    });
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 13, completionTokens: 7, totalTokens: 20 });
  });

  it("ignores agent_usage events for other cases", () => {
    useStore.getState().handleRuntimeEvent({
      type: "agent_usage",
      caseId: "case_2",
      runId: "run_1",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cumulativePromptTokens: 10,
      cumulativeCompletionTokens: 5,
      cumulativeTotalTokens: 15,
    });
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("syncs final token usage from completed run events", () => {
    useStore.getState().handleRuntimeEvent({
      type: "agent_run_completed",
      content: "done",
      run: {
        id: "run_1",
        caseId: "case_1",
        goal: "test",
        status: "completed",
        createdAt: "now",
        startedAt: "now",
        finishedAt: "later",
        interruptReason: null,
        completionReason: "done",
        error: null,
        promptTokens: 36_194,
        completionTokens: 1_413,
        totalTokens: 37_607,
      },
    });

    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 36_194, completionTokens: 1_413, totalTokens: 37_607 });
  });
});

describe("store agent tool events", () => {
  beforeEach(() => {
    resetStore();
  });

  it("shows blocked tool calls in the run console", () => {
    useStore.getState().handleRuntimeEvent({
      type: "agent_tool_blocked",
      caseId: "case_1",
      runId: "run_1",
      tool: "exec_command",
      input: "{\"command\":\"false\"}",
      reason: "identical call already failed in this run",
    });

    expect(useStore.getState().agentEvents.at(-1)).toEqual({
      kind: "tool_result",
      text: "exec_command blocked → identical call already failed in this run\n{\"command\":\"false\"}",
    });
  });
});
describe("store agent streaming", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders one exact message from stream events and the persisted text event", () => {
    const handle = useStore.getState().handleRuntimeEvent;
    handle({ type: "agent_stream_start", caseId: "case_1", runId: "run_1", messageId: "msg_1" });
    handle({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "msg_1", delta: "已将 " });
    handle({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "msg_1", delta: "127.0.0.1 加入范围" });
    handle({ type: "agent_stream_end", caseId: "case_1", runId: "run_1", messageId: "msg_1", content: "已将 127.0.0.1 加入范围。" });
    handle({ type: "agent_reasoning", caseId: "case_1", content: "等待用户批准" });
    handle({ type: "agent_text", caseId: "case_1", content: "已将 127.0.0.1 加入范围。" });

    expect(useStore.getState().agentEvents).toEqual([
      { kind: "text", text: "已将 127.0.0.1 加入范围。" },
      { kind: "reasoning", text: "等待用户批准" },
    ]);
    expect(useStore.getState().streamedAgentTexts).toEqual([]);
  });

  it("keeps distinct streamed messages separate", () => {
    const handle = useStore.getState().handleRuntimeEvent;
    for (const [messageId, content] of [["msg_1", "first"], ["msg_2", "second"]] as const) {
      handle({ type: "agent_stream_start", caseId: "case_1", runId: "run_1", messageId });
      handle({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId, delta: content });
      handle({ type: "agent_stream_end", caseId: "case_1", runId: "run_1", messageId, content });
      handle({ type: "agent_text", caseId: "case_1", content });
    }

    expect(useStore.getState().agentEvents.map((event) => event.text)).toEqual(["first", "second"]);
  });
});
describe("store agent interventions", () => {
  beforeEach(() => {
    resetStore();
  });

  it("does not let an old approval response clear a newer request", () => {
    useStore.setState({ pendingApproval: { approvalId: "approval_new", tool: "write_file", input: "{}" } });

    useStore.getState().handleRuntimeEvent({
      type: "approval_resolved",
      caseId: "case_1",
      approvalId: "approval_old",
      tool: "exec_command",
      decision: "approved",
    });

    expect(useStore.getState().pendingApproval?.approvalId).toBe("approval_new");
  });

  it("keeps a scope proposal pending when an unrelated scope update arrives", () => {
    useStore.setState({ pendingScope: { host: "target.example", reason: "requested target" } });

    useStore.getState().handleRuntimeEvent({
      type: "scope_updated",
      caseId: "case_1",
      allowHosts: ["cdn.example"],
    });

    expect(useStore.getState().pendingScope?.host).toBe("target.example");
  });

  it("records a rejected scope outcome and clears only the matching proposal", () => {
    useStore.setState({ pendingScope: { host: "target.example", reason: "requested target" } });

    useStore.getState().handleRuntimeEvent({
      type: "scope_expansion_rejected",
      caseId: "case_1",
      host: "target.example",
    });

    expect(useStore.getState().pendingScope).toBeNull();
    expect(useStore.getState().agentEvents.at(-1)).toEqual({
      kind: "done",
      text: "Scope kept blocked: target.example",
    });
  });
});
