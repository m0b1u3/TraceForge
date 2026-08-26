import { randomUUID } from "node:crypto";
import { replay, type Fetcher, type ReplayRequest } from "@traceforge/tools";
import { checkScope } from "@traceforge/tool-resolver";
import type { IdentityContext, ScopeRule, TrafficEntry } from "@traceforge/shared";
import { TOOL_SECURITY, type ToolDescriptor } from "./tool.js";
import type { TrafficReader, Emit } from "./case-tools.js";

export interface TrafficWriter {
  add(entry: TrafficEntry): void;
  listByCase(caseId: string): TrafficEntry[];
}

const MAX_BODY_PREVIEW = 2000;

export interface ReplayIdentityContext {
  runId?: string;
  resolveIdentity?: (identityId: string) => IdentityContext | undefined;
}

export function makeHttpReplayTool(
  scopeRules: ScopeRule[],
  fetcher?: Fetcher,
  caseId?: string,
  traffic?: TrafficWriter,
  emit?: Emit,
  context: ReplayIdentityContext = {},
): ToolDescriptor {
  return {
    name: "http_replay",
    description: "Send an HTTP request (modify URL/parameters/header/body) and return status, length, and a body preview. Use this to test API endpoints and observe response differences.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" }, method: { type: "string" },
        headers: { type: "object" }, body: { type: "string" }, identityId: { type: "string" },
      },
      required: ["url", "method"],
    },
    security: TOOL_SECURITY.authorizedTargetWrite,
    source: "builtin",
    execute: async (input) => {
      const value = input as ReplayRequest & { identityId?: string };
      const identity = value.identityId ? context.resolveIdentity?.(value.identityId) : undefined;
      if (value.identityId && !identity) return { ok: false, content: "identity not found" };
      const req = applyIdentity(value, identity);
      const verdict = checkScope(req.url, scopeRules);
      if (!verdict.allowed) {
        return { ok: false, content: `out of scope: ${verdict.reason}` };
      }
      const res = await replay(req, fetcher);
      const entry = recordReplay(caseId, traffic, emit, req, res, {
        runId: context.runId,
        identity,
        attributionSource: "http_replay",
      });
      const bodyPreview = truncate(res.body, MAX_BODY_PREVIEW);
      const content = entry
        ? `status=${res.status} bodyLength=${res.bodyLength}\n\ntrafficId=${entry.id}\n\nbody preview:\n${bodyPreview}`
        : `status=${res.status} bodyLength=${res.bodyLength}\n\nbody preview:\n${bodyPreview}`;
      return { ok: true, content, meta: { status: res.status } };
    },
  };
}

export function makeReplayTrafficTool(
  scopeRules: ScopeRule[],
  trafficReader: TrafficReader,
  fetcher?: Fetcher,
  caseId?: string,
  trafficWriter?: TrafficWriter,
  emit?: Emit,
  context: ReplayIdentityContext = {},
): ToolDescriptor {
  return {
    name: "replay_traffic",
    description: "Replay an existing captured traffic entry by id, optionally overriding URL/method/headers/body. Use this to fuzz or retest discovered API endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        trafficId: { type: "string" },
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
        identityId: { type: "string" },
      },
      required: ["trafficId"],
    },
    security: TOOL_SECURITY.authorizedTargetWrite,
    source: "builtin",
    execute: async (input) => {
      const { trafficId, url, method, headers, body, identityId } = input as {
        trafficId: string;
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        identityId?: string;
      };
      if (!caseId) return { ok: false, content: "caseId not configured" };
      const entry = trafficReader.listByCase(caseId).find((e) => e.id === trafficId);
      if (!entry) return { ok: false, content: `traffic ${trafficId} not found` };
      const identity = identityId ? context.resolveIdentity?.(identityId) : undefined;
      if (identityId && !identity) return { ok: false, content: "identity not found" };
      const req = applyIdentity({
        url: url ?? entry.url,
        method: method ?? entry.method,
        headers: headers ?? entry.requestHeaders,
        body: body ?? (entry.requestBody ?? undefined),
      }, identity);
      const verdict = checkScope(req.url, scopeRules);
      if (!verdict.allowed) return { ok: false, content: `out of scope: ${verdict.reason}` };
      const res = await replay(req, fetcher);
      const recorded = recordReplay(caseId, trafficWriter, emit, req, res, {
        runId: context.runId,
        identity,
        parentTrafficId: trafficId,
        attributionSource: "http_replay",
      });
      const bodyPreview = truncate(res.body, MAX_BODY_PREVIEW);
      const content = recorded
        ? `status=${res.status} bodyLength=${res.bodyLength}\n\nnewTrafficId=${recorded.id}\n\nbody preview:\n${bodyPreview}`
        : `status=${res.status} bodyLength=${res.bodyLength}\n\nbody preview:\n${bodyPreview}`;
      return { ok: true, content, meta: { status: res.status } };
    },
  };
}

function recordReplay(
  caseId: string | undefined,
  traffic: TrafficWriter | undefined,
  emit: Emit | undefined,
  req: ReplayRequest,
  res: { status: number; bodyLength: number; body: string; headers: Record<string, string> },
  attribution: {
    runId?: string;
    identity?: IdentityContext;
    parentTrafficId?: string;
    attributionSource?: TrafficEntry["attributionSource"];
  } = {},
): TrafficEntry | undefined {
  if (!caseId || !traffic || !emit) return undefined;
  const entry: TrafficEntry = {
    id: `traf_${randomUUID()}`,
    caseId,
    runId: attribution.runId ?? null,
    identityId: attribution.identity?.id ?? null,
    identityVersion: attribution.identity?.version ?? null,
    attributionSource: attribution.attributionSource ?? "http_replay",
    parentTrafficId: attribution.parentTrafficId ?? null,
    url: req.url,
    method: req.method,
    requestHeaders: req.headers ?? {},
    requestBody: req.body ?? null,
    responseStatus: res.status,
    responseHeaders: res.headers,
    responseSize: res.bodyLength,
    contentType: res.headers["content-type"] ?? null,
    responseBody: res.body.length > 256_000 ? res.body.slice(0, 256_000) : res.body,
    createdAt: new Date().toISOString(),
  };
  traffic.add(entry);
  emit({ type: "response_captured", entry });
  return entry;
}

function applyIdentity(request: ReplayRequest, identity?: IdentityContext): ReplayRequest {
  if (!identity) return request;
  if (identity.status !== "active") throw new Error(`identity is ${identity.status}`);
  const cookie = identity.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  return {
    ...request,
    headers: {
      ...identity.headers,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(request.headers ?? {}),
    },
  };
}

export function compareTrafficResponses(
  left: Pick<TrafficEntry, "responseStatus" | "responseSize" | "responseBody">,
  right: Pick<TrafficEntry, "responseStatus" | "responseSize" | "responseBody">,
): { statusChanged: boolean; lengthDelta: number; bodySimilarity: number } {
  const leftBody = left.responseBody ?? "";
  const rightBody = right.responseBody ?? "";
  const maxLength = Math.max(leftBody.length, rightBody.length, 1);
  let matching = 0;
  const sampleLength = Math.min(leftBody.length, rightBody.length);
  for (let index = 0; index < sampleLength; index += 1) {
    if (leftBody[index] === rightBody[index]) matching += 1;
  }
  return {
    statusChanged: left.responseStatus !== right.responseStatus,
    lengthDelta: Math.abs((left.responseSize ?? leftBody.length) - (right.responseSize ?? rightBody.length)),
    bodySimilarity: Number((matching / maxLength).toFixed(4)),
  };
}

export function makeCompareIdentityTrafficTool(
  scopeRules: ScopeRule[],
  trafficReader: TrafficReader,
  identities: { getById(id: string): IdentityContext | undefined },
  fetcher?: Fetcher,
  caseId?: string,
  trafficWriter?: TrafficWriter,
  emit?: Emit,
  runId?: string,
): ToolDescriptor {
  return {
    name: "compare_identity_traffic",
    description: "Replay one captured request with two named identities, preserve both derived traffic entries, and return status/body differences for authorization analysis.",
    inputSchema: {
      type: "object",
      properties: {
        trafficId: { type: "string" },
        leftIdentityId: { type: "string" },
        rightIdentityId: { type: "string" },
      },
      required: ["trafficId", "leftIdentityId", "rightIdentityId"],
    },
    security: TOOL_SECURITY.authorizedTargetWrite,
    source: "builtin",
    execute: async (input) => {
      if (!caseId || !trafficWriter || !emit) return { ok: false, content: "traffic persistence is not configured" };
      const { trafficId, leftIdentityId, rightIdentityId } = input as {
        trafficId: string;
        leftIdentityId: string;
        rightIdentityId: string;
      };
      const base = trafficReader.listByCase(caseId).find((entry) => entry.id === trafficId);
      if (!base) return { ok: false, content: `traffic ${trafficId} not found` };
      const leftIdentity = identities.getById(leftIdentityId);
      const rightIdentity = identities.getById(rightIdentityId);
      if (!leftIdentity || !rightIdentity || leftIdentity.caseId !== caseId || rightIdentity.caseId !== caseId) {
        return { ok: false, content: "both identities must exist in this case" };
      }
      const verdict = checkScope(base.url, scopeRules);
      if (!verdict.allowed) return { ok: false, content: `out of scope: ${verdict.reason}` };
      const baseRequest: ReplayRequest = {
        url: base.url,
        method: base.method,
        headers: base.requestHeaders,
        body: base.requestBody ?? undefined,
      };
      try {
        const [leftResponse, rightResponse] = await Promise.all([
          replay(applyIdentity(baseRequest, leftIdentity), fetcher),
          replay(applyIdentity(baseRequest, rightIdentity), fetcher),
        ]);
        const left = recordReplay(caseId, trafficWriter, emit, applyIdentity(baseRequest, leftIdentity), leftResponse, {
          runId, identity: leftIdentity, parentTrafficId: trafficId, attributionSource: "http_replay",
        })!;
        const right = recordReplay(caseId, trafficWriter, emit, applyIdentity(baseRequest, rightIdentity), rightResponse, {
          runId, identity: rightIdentity, parentTrafficId: trafficId, attributionSource: "http_replay",
        })!;
        return {
          ok: true,
          content: JSON.stringify({
            sourceTrafficId: trafficId,
            left: { identityId: leftIdentity.id, trafficId: left.id, status: left.responseStatus, size: left.responseSize },
            right: { identityId: rightIdentity.id, trafficId: right.id, status: right.responseStatus, size: right.responseSize },
            difference: compareTrafficResponses(left, right),
          }, null, 2),
        };
      } catch (error) {
        return { ok: false, content: (error as Error).message };
      }
    },
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...(${text.length - max} more chars)`;
}

export function makeProposeScopeExpansionTool(
  onPropose: (host: string, reason: string) => void,
): ToolDescriptor {
  return {
    name: "propose_scope_expansion",
    description: "当你发现一个疑似与当前目标相关的资产（域名/主机）但它不在授权范围内时，提出将其纳入测试范围的建议。这不会发送任何请求，只是提议，需人工确认。",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string" }, reason: { type: "string" } },
      required: ["host", "reason"],
    },
    security: TOOL_SECURITY.caseWrite,
    source: "builtin",
    execute: async (input) => {
      const { host, reason } = input as { host: string; reason: string };
      onPropose(host, reason);
      return { ok: true, content: `已记录扩范围建议：${host}（${reason}），待人工确认。` };
    },
  };
}
