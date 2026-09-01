import type { BrokeredNetworkReceipt } from "@traceforge/execution-node";

export const WEB_BLACKBOX_HOST_CAPABILITIES = Object.freeze({
  sessions: "traceforge.web-blackbox.sessions@1",
  traffic: "traceforge.web-blackbox.traffic@1",
});

export interface ExecutionCookie {
  name: string; value: string; domain?: string; path?: string; expires?: number;
  httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None";
}
export interface ExecutionSessionDescriptor {
  id: string; caseId: string; runId: string; scopeRef: string; identityId: string | null; identityVersion: number | null;
  status: "active" | "frozen" | "closed" | "expired"; lastWorkerId: string | null; lastWorkId: string | null;
  lastLeaseId: string | null; lastLeaseExpiresAt: string | null; expiresAt: string; createdAt: string; updatedAt: string;
}
export interface SessionUseContext {
  workerId: string; workId: string; caseId: string; runId: string; scopeRef: string; leaseId: string; leaseExpiresAt: string;
}
export interface SessionMaterial { session: ExecutionSessionDescriptor; headers: Record<string, string>; cookies: ExecutionCookie[]; }
export interface ScenarioSessionPort {
  openSession(input: { caseId: string; runId: string; scopeRef: string; identityId?: string; ttlMs?: number }): ExecutionSessionDescriptor;
  use(sessionId: string, context: SessionUseContext): SessionMaterial;
  updateCookies(sessionId: string, cookies: ExecutionCookie[]): void;
}
export interface ScenarioTrafficEntrySummary {
  id: string; runId: string; url: string; method: string; responseStatus: number | null; responseSize: number | null;
  contentType: string | null; createdAt: string;
}
export interface ScenarioTrafficPort {
  recordHttpExchange(input: { trafficId: string; caseId: string; runId: string; url: string; method: string;
    requestHeaders: Record<string, string>; requestBody: string | null; responseStatus: number;
    responseHeaders: Record<string, string>; responseSize: number; contentType: string | null; responseBody: string | null;
    receipt: BrokeredNetworkReceipt; createdAt: string }): void;
  recordBrowserObservation(input: { trafficId: string; caseId: string; runId: string; url: string;
    responseStatus: number | null; responseSize: number; responseBody: string; createdAt: string }): void;
  list(caseId: string, limit: number): ScenarioTrafficEntrySummary[];
}
