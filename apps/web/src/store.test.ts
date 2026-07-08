import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./store.js";

const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
const responses: Response[] = [];

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
    calls.length = 0;
    responses.length = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      const response = responses.shift();
      if (!response) throw new Error("missing scripted fetch response");
      return response;
    };
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

  it("deletes the current case and clears case-scoped state", async () => {
    responses.push(new Response(JSON.stringify({ deleted: true }), { status: 200 }));

    await useStore.getState().deleteCase("case_1");

    expect(calls).toContainEqual(["/api/cases/case_1", { method: "DELETE" }]);
    expect(useStore.getState().caseId).toBeNull();
    expect(useStore.getState().cases).toEqual([]);
    expect(useStore.getState().traffic).toEqual([]);
    expect(useStore.getState().pendingConfirmation).toBeNull();
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

describe("store case hydration", () => {
  beforeEach(() => {
    resetStore();
    calls.length = 0;
    responses.length = 0;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      const response = responses.shift();
      if (!response) throw new Error(`missing scripted fetch response for ${String(input)}`);
      return response;
    };
  });

  it("restores the active run and token usage when entering a case", async () => {
    const activeRun = {
      id: "run_1",
      caseId: "case_1",
      goal: "继续测试",
      status: "running" as const,
      createdAt: "now",
      startedAt: "now",
      finishedAt: null,
      interruptReason: null,
      completionReason: null,
      error: null,
      promptTokens: 36_194,
      completionTokens: 1_413,
      totalTokens: 37_607,
    };
    responses.push(
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify({ warnings: [], total: 0 }), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify(activeRun), { status: 200 }),
    );

    await useStore.getState().enterCase("case_1");

    expect(calls.map(([input]) => input)).toContain("/api/cases/case_1/agent/runs/active");
    expect(useStore.getState().activeRun).toEqual(activeRun);
    expect(useStore.getState().agentBusy).toBe(true);
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 36_194, completionTokens: 1_413, totalTokens: 37_607 });
  });

  it("restores token usage from the latest run when no run is active", async () => {
    const latestRun = {
      id: "run_1",
      caseId: "case_1",
      goal: "完成测试",
      status: "completed" as const,
      createdAt: "now",
      startedAt: "now",
      finishedAt: "later",
      interruptReason: null,
      completionReason: "done",
      error: null,
      promptTokens: 36_194,
      completionTokens: 1_413,
      totalTokens: 37_607,
    };
    responses.push(
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify({ warnings: [], total: 0 }), { status: 200 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify(null), { status: 200 }),
      new Response(JSON.stringify(latestRun), { status: 200 }),
    );

    await useStore.getState().enterCase("case_1");

    expect(calls.map(([input]) => input)).toContain("/api/cases/case_1/agent/runs/latest");
    expect(useStore.getState().activeRun).toBeNull();
    expect(useStore.getState().agentBusy).toBe(false);
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 36_194, completionTokens: 1_413, totalTokens: 37_607 });
  });
});
