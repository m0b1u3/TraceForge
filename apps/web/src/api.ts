import type { Case, CaseSummary, TrafficEntry, Fact, Task, TimelineEntry, ObserverWarning, AgentEvent, AgentRun, AgentRunUsage, AttackPath, IdentityContext, SecurityReport, SecurityReportRevision } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";

export interface LlmConfig {
  provider: "anthropic" | "openai";
  model: string;
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
  baseUrl?: string;
  apiKey?: string;
  jsonMode?: "json_schema" | "json_object";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  currency?: string | null;
  inputPricePerMillion?: number | null;
  outputPricePerMillion?: number | null;
}

async function ensureOk(r: Response, action: string): Promise<Response> {
  if (r.ok) return r;
  let reason = `${r.status}`;
  try {
    const body = await r.json();
    reason = body.reason || body.error || reason;
  } catch { /* Keep the status code for non-JSON responses. */ }
  throw new Error(`${action} failed: ${reason}`);
}

export async function createCase(name: string, allowHosts: string[]): Promise<Case> {
  const r = await fetch("/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, allowHosts }),
  });
  await ensureOk(r, "Create case");
  return r.json();
}

export async function deleteCase(caseId: string): Promise<{ deleted: boolean }> {
  const r = await fetch(`/api/cases/${caseId}`, { method: "DELETE" });
  await ensureOk(r, "Delete case");
  return r.json();
}

export interface BrowserRuntimeState {
  ok: boolean;
  controller: "llm" | "human" | null;
  url?: string;
}

export interface HistoryPage {
  limit?: number;
  offset?: number;
}

function historyUrl(path: string, page?: HistoryPage): string {
  if (!page?.limit) return path;
  const query = new URLSearchParams({
    limit: String(page.limit),
    offset: String(page.offset ?? 0),
  });
  return `${path}?${query}`;
}

export async function getBrowserState(caseId: string): Promise<BrowserRuntimeState> {
  const response = await ensureOk(await fetch(`/api/cases/${caseId}/browser`), "Load browser state");
  return response.json() as Promise<BrowserRuntimeState>;
}

export async function startBrowser(caseId: string): Promise<BrowserRuntimeState> {
  const response = await ensureOk(await fetch(`/api/cases/${caseId}/browser/start`, { method: "POST" }), "Start browser");
  return response.json() as Promise<BrowserRuntimeState>;
}
export async function stopBrowser(caseId: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/browser/stop`, { method: "POST" }), "Stop browser");
}
export async function takeoverBrowser(caseId: string): Promise<BrowserRuntimeState> {
  const response = await ensureOk(await fetch(`/api/cases/${caseId}/browser/takeover`, { method: "POST" }), "Take over browser");
  return response.json() as Promise<BrowserRuntimeState>;
}
export async function releaseBrowser(caseId: string): Promise<BrowserRuntimeState> {
  const response = await ensureOk(await fetch(`/api/cases/${caseId}/browser/release`, { method: "POST" }), "Return browser control");
  return response.json() as Promise<BrowserRuntimeState>;
}

export async function listTraffic(caseId: string, page?: HistoryPage): Promise<TrafficEntry[]> {
  const r = await fetch(historyUrl(`/api/cases/${caseId}/traffic`, page));
  await ensureOk(r, "Load traffic");
  return r.json();
}

export async function listAttackPaths(caseId: string): Promise<AttackPath[]> {
  const response = await ensureOk(await fetch(`/api/cases/${caseId}/attack-paths`), "Load attack paths");
  return response.json();
}

export async function listIdentities(caseId: string): Promise<IdentityContext[]> {
  const response = await ensureOk(await fetch(`/api/cases/${caseId}/identities`), "Load identities");
  return response.json();
}

export async function listSecurityReports(caseId: string): Promise<SecurityReport[]> {
  const response = await ensureOk(await fetch(`/api/cases/${caseId}/security-reports`), "Load security reports");
  return response.json();
}

export async function downloadSecurityReport(caseId: string, reportId: string, format: "markdown" | "json"): Promise<void> {
  const response = await ensureOk(
    await fetch(`/api/cases/${caseId}/security-reports/${reportId}/export?format=${format}`),
    "Export security report",
  );
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `security-report.${format === "json" ? "json" : "md"}`;
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function listSecurityReportRevisions(caseId: string, reportId: string): Promise<SecurityReportRevision[]> {
  const response = await ensureOk(
    await fetch(`/api/cases/${caseId}/security-reports/${reportId}/revisions`),
    "Load report revisions",
  );
  return response.json();
}

export async function acceptSecurityReportRevision(caseId: string, reportId: string, revisionId: string): Promise<SecurityReportRevision> {
  const response = await ensureOk(
    await fetch(`/api/cases/${caseId}/security-reports/${reportId}/revisions/${revisionId}/accept`, { method: "POST" }),
    "Accept report revision",
  );
  return response.json();
}

export async function clearTraffic(caseId: string): Promise<{ deleted: number }> {
  const response = await ensureOk(await fetch(`/api/cases/${caseId}/traffic`, { method: "DELETE" }), "Clear traffic");
  return response.json() as Promise<{ deleted: number }>;
}

export async function createFact(
  caseId: string,
  input: Omit<Fact, "id" | "caseId" | "createdAt" | "confidence" | "tags" | "updateCount" | "updatedAt" | "validity"> &
    Partial<Pick<Fact, "confidence" | "tags">>,
): Promise<Fact> {
  const r = await fetch(`/api/cases/${caseId}/facts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(r, "Create fact");
  return r.json();
}

export async function listFacts(caseId: string): Promise<Fact[]> {
  return (await fetch(`/api/cases/${caseId}/facts`)).json();
}

export async function createTask(
  caseId: string,
  input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt" | "updateCount"> &
    Partial<Pick<Task, "updateCount">>,
): Promise<Task> {
  const r = await fetch(`/api/cases/${caseId}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(r, "Create task");
  return r.json();
}

export async function listTasks(caseId: string): Promise<Task[]> {
  return (await fetch(`/api/cases/${caseId}/tasks`)).json();
}

export async function patchTask(taskId: string, status: Task["status"], reason?: string): Promise<Task> {
  const r = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, reason }),
  });
  await ensureOk(r, "Update task status");
  return r.json();
}

export async function listTimeline(caseId: string, page?: HistoryPage): Promise<TimelineEntry[]> {
  const response = await ensureOk(await fetch(historyUrl(`/api/cases/${caseId}/timeline`, page)), "Load timeline");
  return response.json();
}

export async function runAgent(caseId: string, goal: string): Promise<AgentRun> {
  const r = await ensureOk(await fetch(`/api/cases/${caseId}/agent/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }),
  }), "Run Agent");
  return (await r.json()).run;
}

export async function steerAgentRun(runId: string, content: string): Promise<AgentRun> {
  const r = await ensureOk(await fetch(`/api/agent/runs/${runId}/steer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
  }), "Add steering instruction");
  return (await r.json()).run;
}

export async function interruptAgentRun(runId: string, reason?: string): Promise<AgentRun> {
  const r = await ensureOk(await fetch(`/api/agent/runs/${runId}/interrupt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
  }), "Stop Agent");
  return (await r.json()).run;
}

export async function getActiveAgentRun(caseId: string): Promise<AgentRun | null> {
  return (await fetch(`/api/cases/${caseId}/agent/runs/active`)).json();
}

export async function getLatestAgentRun(caseId: string): Promise<AgentRun | null> {
  return (await fetch(`/api/cases/${caseId}/agent/runs/latest`)).json();
}

export async function getAgentRunUsage(runId: string): Promise<AgentRunUsage[]> {
  return (await fetch(`/api/agent/runs/${runId}/usage`)).json();
}

export interface PendingInterventions {
  approval: { approvalId: string; tool: string; input: string } | null;
  scope: { host: string; reason: string } | null;
}

export async function getPendingInterventions(caseId: string): Promise<PendingInterventions> {
  return (await fetch(`/api/cases/${caseId}/interventions/pending`)).json();
}

export async function resolveApproval(approvalId: string, decision: "approved" | "rejected"): Promise<void> {
  await ensureOk(await fetch(`/api/agent/approvals/${approvalId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
  }), "Submit approval");
}

export async function listCases(): Promise<Case[]> {
  return (await fetch("/api/cases")).json();
}

export async function listCaseSummaries(): Promise<CaseSummary[]> {
  const response = await ensureOk(await fetch("/api/cases/summary"), "Load case summaries");
  return response.json() as Promise<CaseSummary[]>;
}

export async function updateCase(caseId: string, patch: Partial<Pick<Case, "name" | "status">>): Promise<Case> {
  const response = await ensureOk(await fetch(`/api/cases/${caseId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }), "Update case");
  return response.json() as Promise<Case>;
}

export async function listMcpTools(): Promise<McpToolHandle[]> {
  return (await fetch("/api/mcp/tools")).json();
}

export async function listWarnings(caseId: string): Promise<ObserverWarning[]> {
  const body = await (await fetch(`/api/cases/${caseId}/warnings`)).json();
  return Array.isArray(body) ? body : body.warnings ?? [];
}

export async function acceptObserverWarning(warningId: string): Promise<ObserverWarning> {
  const r = await ensureOk(await fetch(`/api/observer/warnings/${warningId}/accept`, { method: "POST" }), "Resume Observer warning");
  return r.json();
}

export async function dismissObserverWarning(warningId: string): Promise<ObserverWarning> {
  const r = await ensureOk(await fetch(`/api/observer/warnings/${warningId}/dismiss`, { method: "POST" }), "Ignore Observer warning");
  return r.json();
}

export async function convertObserverWarningToTask(warningId: string): Promise<{ warning: ObserverWarning; task: Task }> {
  const r = await ensureOk(await fetch(`/api/observer/warnings/${warningId}/convert-task`, { method: "POST" }), "Create Observer task");
  return r.json();
}

export async function listAgentEvents(caseId: string, page?: HistoryPage): Promise<AgentEvent[]> {
  const response = await ensureOk(await fetch(historyUrl(`/api/cases/${caseId}/agent/events`, page)), "Load Agent history");
  return response.json();
}

export async function approveScope(caseId: string, host: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/scope/approve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host }),
  }), "Approve scope");
}

export async function rejectScope(caseId: string, host: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/scope/reject`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host }),
  }), "Keep scope blocked");
}

export async function getLlmConfig(): Promise<LlmConfig> {
  const r = await fetch("/api/config/llm");
  await ensureOk(r, "Load LLM config");
  return r.json();
}

export async function updateLlmConfig(input: LlmConfigInput): Promise<LlmConfig> {
  const r = await fetch("/api/config/llm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(r, "Save LLM config");
  return r.json();
}

export async function testLlmConfig(input: LlmConfigInput): Promise<{ ok: boolean; message?: string; error?: string }> {
  const r = await fetch("/api/config/llm/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(r, "Test LLM connection");
  return r.json();
}
