import type { Case, TrafficEntry } from "@traceforge/shared";

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
