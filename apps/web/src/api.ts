import type { Case, TrafficEntry, Fact, Task, TimelineEntry } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";

export async function createCase(name: string, allowHosts: string[]): Promise<Case> {
  const r = await fetch("/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, allowHosts }),
  });
  return r.json();
}

export async function startBrowser(caseId: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/browser/start`, { method: "POST" });
}
export async function stopBrowser(caseId: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/browser/stop`, { method: "POST" });
}
export async function takeoverBrowser(caseId: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/browser/takeover`, { method: "POST" });
}
export async function releaseBrowser(caseId: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/browser/release`, { method: "POST" });
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
  return r.json();
}

export async function listTimeline(caseId: string): Promise<TimelineEntry[]> {
  return (await fetch(`/api/cases/${caseId}/timeline`)).json();
}

export async function runAgent(caseId: string, goal: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/agent/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }),
  });
}

export async function resolveApproval(approvalId: string, decision: "approved" | "rejected"): Promise<Response> {
  return fetch(`/api/agent/approvals/${approvalId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
  });
}

export async function listCases(): Promise<Case[]> {
  return (await fetch("/api/cases")).json();
}

export async function listMcpTools(): Promise<McpToolHandle[]> {
  return (await fetch("/api/mcp/tools")).json();
}
