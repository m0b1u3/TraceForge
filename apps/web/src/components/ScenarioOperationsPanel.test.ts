import { describe, expect, it } from "vitest";
import type { ScenarioAuthorization, ScenarioRunState } from "../api.js";
import { authorizationIsUsable, normalizeAuthorizationTarget, scenarioRunProgress } from "./ScenarioOperationsPanel.js";

const authorization: ScenarioAuthorization = {
  id: "authorization_1",
  caseId: "case_1",
  scenarioKind: "web_blackbox",
  scope: { targets: ["https://target.example"], allowedActions: ["scope.read"], deniedActions: [] },
  approvedBy: "operator",
  status: "active",
  expiresAt: "2026-08-25T14:00:00.000Z",
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z",
};

function run(): ScenarioRunState {
  const work = (id: string, status: ScenarioRunState["workItems"][number]["status"]) => ({
    id, runId: "run_1", phaseId: "surface_mapping", kind: "research" as const,
    title: id, objective: id, priority: 50, status,
    allowedWorkerRoles: ["researcher"], requiredCapabilities: [], hypothesisIds: [], evidenceRefs: [],
    workerId: null, leaseId: null, leaseExpiresAt: null, attempt: 1, maxAttempts: 3,
    idempotencyKey: id, latestCheckpoint: null, resumeFromCheckpoint: false, resultSummary: null, error: null,
    createdAt: "2026-08-25T12:00:00.000Z", startedAt: null, finishedAt: null,
  });
  return {
    id: "run_1", caseId: "case_1", definitionKind: "web_blackbox", definitionVersion: 1,
    goal: "Assess the authorized target", scopeRef: authorization.id, status: "running",
    activePhaseId: "surface_mapping", availableCapabilities: [],
    workItems: [work("completed", "completed"), work("running", "running"), work("queued", "queued"), work("approval", "waiting_approval")],
    outputs: [], directives: [], revision: 8, blockedReason: null, suspension: null,
    createdAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:01:00.000Z", completedAt: null,
  };
}

describe("ScenarioOperationsPanel helpers", () => {
  it("accepts only active, unexpired authorizations", () => {
    expect(authorizationIsUsable(authorization, Date.parse("2026-08-25T13:00:00.000Z"))).toBe(true);
    expect(authorizationIsUsable({ ...authorization, status: "revoked" }, Date.parse("2026-08-25T13:00:00.000Z"))).toBe(false);
    expect(authorizationIsUsable(authorization, Date.parse(authorization.expiresAt))).toBe(false);
  });

  it("summarizes deterministic Work lifecycle counts", () => {
    expect(scenarioRunProgress(run())).toEqual({ completed: 1, active: 2, waiting: 1, total: 4 });
  });

  it("normalizes HTTP targets and rejects unsupported protocols", () => {
    expect(normalizeAuthorizationTarget("target.example/app")).toBe("https://target.example/app");
    expect(normalizeAuthorizationTarget("http://target.example/")).toBe("http://target.example");
    expect(normalizeAuthorizationTarget("file:///tmp/target")).toBeNull();
  });
});
