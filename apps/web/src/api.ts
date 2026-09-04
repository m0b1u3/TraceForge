import type { Case, CaseSummary, ScenarioAgentEvent } from "@traceforge/shared";

export interface LlmConfig {
  provider: "anthropic" | "openai";
  model: string;
  embeddingModel?: string;
  baseUrl?: string;
  apiKeyMasked: string;
  jsonMode?: "json_schema" | "json_object";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  currency?: string;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}

export interface LlmConfigInput {
  provider: "anthropic" | "openai";
  model: string;
  embeddingModel?: string;
  baseUrl?: string;
  apiKey?: string;
  jsonMode?: "json_schema" | "json_object";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  currency?: string | null;
  inputPricePerMillion?: number | null;
  outputPricePerMillion?: number | null;
}

export interface ScenarioRunSummary {
  runId: string; caseId: string; definitionKind: string; definitionVersion: number;
  scenarioPackage: { id: string; version: string; schemaRevision: number } | null;
  packageAvailability: "available" | "recovery_required";
  packageDiagnostic: string | null;
  status: string; activePhaseId: string; revision: number; createdAt: string; updatedAt: string;
}

export interface ScenarioAuthorization {
  id: string;
  caseId: string;
  scenarioKind: string;
  scope: { targets: string[]; allowedActions: string[]; deniedActions: string[]; notes?: string };
  approvedBy: string;
  status: "active" | "revoked";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioApproval {
  id: string;
  runId: string;
  caseId: string;
  workId: string;
  actionKey: string;
  toolName: string;
  risk: "read_only" | "bounded_write" | "privileged" | "destructive";
  rationale: string;
  inputRef: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedByWorkerId: string;
  resolutionReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ScenarioDefinitionView {
  kind: string;
  version: number;
  title: string;
  authorizationActions: string[];
  requiredCapabilities: string[];
  initialPhaseId: string;
  agentTopology: {
    planner: { enabled: boolean };
    observer: { enabled: boolean };
    workerPools: Array<{ id: string; role: string; activation: string; minimumInstances: number; maximumInstances: number; maxConcurrentWork: number; capabilities: string[] }>;
  };
  phases: Array<{ id: string; title: string; objective: string; allowedWorkKinds: string[]; maxParallelWork: number; requiredCapabilities: string[] }>;
}

export interface ScenarioRunState {
  id: string;
  caseId: string;
  definitionKind: ScenarioDefinitionView["kind"];
  definitionVersion: number;
  scenarioPackage: { id: string; version: string; schemaRevision: number };
  goal: string;
  scopeRef: string;
  status: "running" | "paused" | "blocked" | "completed" | "cancelled";
  activePhaseId: string;
  availableCapabilities: string[];
  workItems: Array<{
    id: string; runId: string; phaseId: string; kind: string;
    title: string; objective: string; priority: number;
    status: "queued" | "running" | "waiting_approval" | "completed" | "blocked" | "failed" | "cancelled";
    allowedWorkerRoles: string[]; requiredCapabilities: string[]; hypothesisIds: string[]; evidenceRefs: string[];
    workerId: string | null; leaseId: string | null; leaseExpiresAt: string | null; attempt: number; maxAttempts: number;
    idempotencyKey: string;
    latestCheckpoint: { id: string; workId: string; leaseId: string; progressSummary: string; payloadRef: string; createdAt: string } | null;
    resumeFromCheckpoint: boolean;
    resultSummary: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  }>;
  outputs: Array<{ id: string; kind: string; summary: string; refs: string[]; phaseId: string; producedByWorkId: string; createdAt: string }>;
  directives: Array<{ id: string; kind: "steer"; targetWorkId: string; instruction: string; rationale: string; issuedBy: "observer"; createdAt: string }>;
  revision: number;
  blockedReason: string | null;
  suspension: { reason: string; requestedBy: "operator" | "system"; pausedAt: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface ScenarioCommandResult { state: ScenarioRunState; idempotentReplay: boolean }

export interface ScenarioRunRecoveryDiagnostic {
  runId: string;
  status: ScenarioRunState["status"];
  runRevision: number;
  projectionMatchesReplay: boolean;
  projectionIssues: string[];
  activeLeases: Array<{
    workId: string; workerId: string; leaseId: string; leaseExpiresAt: string;
    checkpointRef: string | null; resumableFromCheckpoint: boolean;
  }>;
  queuedCheckpointWorkIds: string[];
  pendingApprovalIds: string[];
  suspension: ScenarioRunState["suspension"];
}

export interface ScenarioRunReplay {
  runId: string; revision: number; currentRevision: number; eventCount: number;
  stateDigest: string; isCurrent: boolean; state: ScenarioRunState;
}

export type CognitiveAgentStatus = "disabled" | "unavailable" | "awaiting_state" | "applying" | "observing";
export type WorkerHealth = "healthy" | "stale" | "draining" | "offline";
export type PlannerDecision =
  | { action: "wait"; rationale: string }
  | {
      action: "plan"; rationale: string;
      proposals: Array<{ kind: string; title: string; objective: string; priority: number }>;
      cancellations: Array<{ workId: string; reason: string }>;
      reprioritizations: Array<{ workId: string; priority: number; reason: string }>;
    };
export type ObserverDecision =
  | { action: "continue"; rationale: string }
  | { action: "steer"; workId: string; instruction: string; rationale: string }
  | { action: "terminate_branch"; workId: string; reason: string }
  | { action: "terminate_run"; reason: string };

export interface ScenarioCollaborationSnapshot {
  runId: string;
  caseId: string;
  capturedAt: string;
  runRevision: number;
  graphRevision: number;
  agents: {
    planner: {
      status: CognitiveAgentStatus;
      evaluationCount: number;
      evaluations: Array<{
        id: string; decision: PlannerDecision; applied: boolean; observedRunRevision: number;
        resultingRunRevision: number | null; createdAt: string; appliedAt: string | null;
      }>;
    };
    observer: {
      status: CognitiveAgentStatus;
      evaluationCount: number;
      evaluations: Array<{
        id: string; decision: ObserverDecision; applied: boolean; observedRunRevision: number;
        resultingRunRevision: number | null; createdAt: string; appliedAt: string | null;
      }>;
    };
  };
  workerPools: Array<{
    id: string; role: string; activation: string; registeredCount: number; healthyCount: number;
    queuedWork: number; runningWork: number; activeLeases: number; maximumInstances: number;
  }>;
  workers: Array<{
    id: string; roles: string[]; capabilities: string[]; status: "online" | "draining" | "offline";
    health: WorkerHealth; heartbeatAt: string; heartbeatAgeMs: number | null; maxConcurrentWork: number;
    activeWork: number; availableSlots: number;
    runLeases: Array<{
      runId: string; workId: string; workerId: string; leaseId: string; leaseExpiresAt: string;
      updatedAt: string; expired: boolean; expiresInMs: number;
    }>;
  }>;
  knowledge: {
    totalNodes: number; totalEdges: number; countsByKind: Record<string, number>; countsByStatus: Record<string, number>;
    nodes: Array<{
      id: string; runId: string | null; kind: string; title: string; summary: string; status: string;
      confidence: number; updatedAt: string;
    }>;
    edges: Array<{ id: string; sourceId: string; targetId: string; relation: string; rationale: string; createdAt: string }>;
    truncated: boolean;
  };
  workLinks: Array<{
    workId: string; hypothesisNodeIds: string[]; evidenceNodeIds: string[]; outputIds: string[];
    linkedNodeIds: string[]; externalRefs: string[];
  }>;
}

export interface ScenarioAgentEventPage { events: ScenarioAgentEvent[]; nextCursor: number; hasMore: boolean }

async function ensureOk(response: Response, action: string): Promise<Response> {
  if (response.ok) return response;
  let reason = String(response.status);
  try {
    const body = await response.json() as { reason?: string; error?: string };
    reason = body.reason ?? body.error ?? reason;
  } catch { /* Preserve HTTP status for non-JSON failures. */ }
  throw new Error(`${action} failed: ${reason}`);
}

export async function createCase(name: string, allowHosts: string[]): Promise<Case> {
  return (await ensureOk(await fetch("/api/cases", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, allowHosts }),
  }), "Create Case")).json();
}

export async function listCases(): Promise<Case[]> {
  return (await ensureOk(await fetch("/api/cases"), "Load Cases")).json();
}

export async function listCaseSummaries(): Promise<CaseSummary[]> {
  return (await ensureOk(await fetch("/api/cases/summary"), "Load Case summaries")).json();
}

export async function updateCase(caseId: string, patch: Partial<Pick<Case, "name" | "status">>): Promise<Case> {
  return (await ensureOk(await fetch(`/api/cases/${caseId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
  }), "Update Case")).json();
}

export async function deleteCase(caseId: string): Promise<{ deleted: boolean }> {
  return (await ensureOk(await fetch(`/api/cases/${caseId}`, { method: "DELETE" }), "Delete Case")).json();
}

export async function listScenarioRuns(caseId: string): Promise<ScenarioRunSummary[]> {
  return (await ensureOk(await fetch(`/api/scenarios/runs?${new URLSearchParams({ caseId })}`), "Load Scenario Runs")).json();
}

export async function listScenarioDefinitions(): Promise<ScenarioDefinitionView[]> {
  return (await ensureOk(await fetch("/api/scenarios/definitions"), "Load Scenario Profiles")).json();
}

export async function listScenarioAuthorizations(caseId: string): Promise<ScenarioAuthorization[]> {
  return (await ensureOk(await fetch(`/api/scenarios/authorizations?${new URLSearchParams({ caseId })}`), "Load authorizations")).json();
}

export async function createScenarioAuthorization(input: {
  caseId: string;
  scenarioKind: "web_blackbox";
  targets: string[];
  allowedActions: string[];
  deniedActions: string[];
  approvedBy: string;
  expiresAt: string;
  notes?: string;
}): Promise<ScenarioAuthorization> {
  const id = crypto.randomUUID();
  return (await ensureOk(await fetch("/api/scenarios/authorizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id,
      caseId: input.caseId,
      scenarioKind: input.scenarioKind,
      scope: { targets: input.targets, allowedActions: input.allowedActions, deniedActions: input.deniedActions, notes: input.notes },
      approvedBy: input.approvedBy,
      expiresAt: input.expiresAt,
    }),
  }), "Create authorization")).json();
}

export async function revokeScenarioAuthorization(authorizationId: string): Promise<{ id: string; status: "revoked"; cancelledRunIds: string[] }> {
  return (await ensureOk(await fetch(`/api/scenarios/authorizations/${encodeURIComponent(authorizationId)}/revoke`, { method: "POST" }), "Revoke authorization")).json();
}

export async function getScenarioRun(runId: string): Promise<ScenarioRunState> {
  return (await ensureOk(await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}`), "Load Scenario Run")).json();
}

export async function getScenarioCollaboration(runId: string): Promise<ScenarioCollaborationSnapshot> {
  return (await ensureOk(
    await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}/collaboration`),
    "Load collaboration snapshot",
  )).json();
}

export async function createScenarioRun(input: {
  caseId: string;
  goal: string;
  scopeRef: string;
  scenarioKind: "web_blackbox";
  definitionVersion: number;
}): Promise<ScenarioCommandResult> {
  const runId = crypto.randomUUID();
  return (await ensureOk(await fetch("/api/scenarios/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, runId, commandId: crypto.randomUUID() }),
  }), "Start Scenario Run")).json();
}

export async function cancelScenarioRun(runId: string, expectedRevision: number, reason: string): Promise<ScenarioCommandResult> {
  return (await ensureOk(await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID(), expectedRevision, reason }),
  }), "Cancel Scenario Run")).json();
}

export async function pauseScenarioRun(runId: string, expectedRevision: number, reason: string): Promise<ScenarioCommandResult> {
  return (await ensureOk(await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}/pause`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID(), expectedRevision, reason }),
  }), "Pause Scenario Run")).json();
}

export async function resumeScenarioRun(runId: string, expectedRevision: number, reason: string): Promise<ScenarioCommandResult> {
  return (await ensureOk(await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID(), expectedRevision, reason }),
  }), "Resume Scenario Run")).json();
}

export async function getScenarioRunRecovery(runId: string): Promise<ScenarioRunRecoveryDiagnostic> {
  return (await ensureOk(await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}/recovery`), "Load Run recovery diagnostic")).json();
}

export async function getScenarioRunReplay(runId: string, revision?: number): Promise<ScenarioRunReplay> {
  const query = revision === undefined ? "" : `?${new URLSearchParams({ revision: String(revision) })}`;
  return (await ensureOk(await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}/replay${query}`), "Replay Scenario Run")).json();
}

export async function listScenarioApprovals(caseId: string, status?: ScenarioApproval["status"]): Promise<ScenarioApproval[]> {
  const query = new URLSearchParams({ caseId });
  if (status) query.set("status", status);
  return (await ensureOk(await fetch(`/api/scenarios/approvals?${query}`), "Load approvals")).json();
}

export async function resolveScenarioApproval(
  approvalId: string,
  expectedRevision: number,
  approved: boolean,
  reason: string,
): Promise<ScenarioCommandResult> {
  return (await ensureOk(await fetch(`/api/scenarios/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID(), expectedRevision, approved, reason }),
  }), approved ? "Approve action" : "Reject action")).json();
}

export async function getScenarioAgentEvents(runId: string, after = 0, limit = 1_000): Promise<ScenarioAgentEventPage> {
  const query = new URLSearchParams({ after: String(after), limit: String(limit) });
  return (await ensureOk(await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}/agent-events?${query}`), "Replay Agent protocol events")).json();
}

export async function getLlmConfig(): Promise<LlmConfig> {
  return (await ensureOk(await fetch("/api/config/llm"), "Load LLM config")).json();
}

export async function updateLlmConfig(input: LlmConfigInput): Promise<LlmConfig> {
  return (await ensureOk(await fetch("/api/config/llm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }), "Save LLM config")).json();
}

export async function testLlmConfig(input: LlmConfigInput): Promise<{ ok: boolean; message?: string; error?: string }> {
  return (await ensureOk(await fetch("/api/config/llm/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }), "Test LLM config")).json();
}
