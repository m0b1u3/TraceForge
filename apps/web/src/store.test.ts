import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "./store.js";

function resetStore() {
  useStore.setState({
    caseId: "case_1",
    pendingConfirmation: null,
    activeTab: "facts",
    agentEvents: [],
    activeRun: null,
    agentBusy: false,
    toast: null,
    warnings: [],
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
  beforeEach(() => resetStore());

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
});
