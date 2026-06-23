import type { Case, TrafficEntry, Fact, Task, TimelineEntry, CandidateFact, ActionCard, Decision } from "@traceforge/shared";

export async function createCase(name: string, allowHosts: string[]): Promise<Case> {
  const r = await fetch("/api/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, allowHosts }),
  });
  return r.json();
}

export async function openUrl(caseId: string, url: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
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

export async function extractCandidates(caseId: string, trafId: string): Promise<CandidateFact[]> {
  return (await fetch(`/api/cases/${caseId}/traffic/${trafId}/extract`, { method: "POST" })).json();
}

export async function confirmCandidate(candId: string): Promise<Fact> {
  return (await fetch(`/api/candidates/${candId}/confirm`, { method: "POST" })).json();
}

export async function rejectCandidate(candId: string): Promise<Response> {
  return fetch(`/api/candidates/${candId}/reject`, { method: "POST" });
}

export async function planActions(caseId: string): Promise<ActionCard[]> {
  return (await fetch(`/api/cases/${caseId}/plan-actions`, { method: "POST" })).json();
}

export async function approveAction(acandId: string): Promise<{ action: ActionCard; decision: Decision }> {
  return (await fetch(`/api/action-candidates/${acandId}/approve`, { method: "POST" })).json();
}

export async function rejectAction(acandId: string): Promise<Response> {
  return fetch(`/api/action-candidates/${acandId}/reject`, { method: "POST" });
}
