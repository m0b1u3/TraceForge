import type { Case, TrafficEntry, Fact, Task, TimelineEntry, ObserverWarning, AgentEvent, AgentRun } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";

export interface LlmConfig {
  provider: "anthropic" | "openai";
  model: string;
  baseUrl?: string;
  apiKeyEnv: string;
  apiKeyMasked: string;
  jsonMode?: "json_schema" | "json_object";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface LlmConfigInput {
  provider: "anthropic" | "openai";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  jsonMode?: "json_schema" | "json_object";
  apiKeyEnv?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
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

export async function startBrowser(caseId: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/browser/start`, { method: "POST" }), "Start browser");
}
export async function stopBrowser(caseId: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/browser/stop`, { method: "POST" }), "Stop browser");
}
export async function takeoverBrowser(caseId: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/browser/takeover`, { method: "POST" }), "Take over browser");
}
export async function releaseBrowser(caseId: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/browser/release`, { method: "POST" }), "Return browser control");
}

export async function listTraffic(caseId: string): Promise<TrafficEntry[]> {
  const r = await fetch(`/api/cases/${caseId}/traffic`);
  return r.json();
}

export async function createFact(
  caseId: string,
  input: Omit<Fact, "id" | "caseId" | "createdAt" | "confidence" | "tags"> &
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
  input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt">,
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

export async function listTimeline(caseId: string): Promise<TimelineEntry[]> {
  return (await fetch(`/api/cases/${caseId}/timeline`)).json();
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

export async function resolveApproval(approvalId: string, decision: "approved" | "rejected"): Promise<void> {
  await ensureOk(await fetch(`/api/agent/approvals/${approvalId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
  }), "Submit approval");
}

export async function listCases(): Promise<Case[]> {
  return (await fetch("/api/cases")).json();
}

export async function listMcpTools(): Promise<McpToolHandle[]> {
  return (await fetch("/api/mcp/tools")).json();
}

export async function listWarnings(caseId: string): Promise<ObserverWarning[]> {
  return (await fetch(`/api/cases/${caseId}/warnings`)).json();
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

export async function listAgentEvents(caseId: string): Promise<AgentEvent[]> {
  return (await fetch(`/api/cases/${caseId}/agent/events`)).json();
}

export async function approveScope(caseId: string, host: string): Promise<void> {
  await ensureOk(await fetch(`/api/cases/${caseId}/scope/approve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host }),
  }), "Approve scope");
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
