import { describe, expect, it } from "vitest";
import { ScenarioKernel, WEB_BLACKBOX_SCENARIO } from "@traceforge/orchestration-core";
import { desiredWorkerCount } from "./embedded-workers.js";

describe("Scenario Profile Worker topology", () => {
  it("keeps a resident Researcher and activates isolated roles only when their Work exists", () => {
    const state = new ScenarioKernel(WEB_BLACKBOX_SCENARIO).execute(undefined, {
      type: "start_run", runId: "run_1", caseId: "case_1", goal: "Assess", scopeRef: "scope_1",
      availableCapabilities: ["scope.read", "evidence.write"], at: "2026-08-25T08:00:00.000Z",
    }).state;
    const pools = Object.fromEntries(WEB_BLACKBOX_SCENARIO.agentTopology.workerPools.map((pool) => [pool.role, pool]));
    expect(desiredWorkerCount(pools.researcher, [state])).toBe(1);
    expect(desiredWorkerCount(pools.validator, [state])).toBe(0);
    expect(desiredWorkerCount(pools.reviewer, [state])).toBe(0);
    expect(desiredWorkerCount(pools.reporter, [state])).toBe(0);
  });
});
