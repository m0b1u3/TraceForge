import { randomUUID } from "node:crypto";
import { replay, type Fetcher, type ReplayRequest } from "@traceforge/tools";
import { checkScope } from "@traceforge/tool-resolver";
import type { ScopeRule, TrafficEntry } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";
import type { TrafficReader, Emit } from "./case-tools.js";

export interface TrafficWriter {
  add(entry: TrafficEntry): void;
  listByCase(caseId: string): TrafficEntry[];
}

const MAX_BODY_PREVIEW = 2000;

export function makeHttpReplayTool(
  scopeRules: ScopeRule[],
  fetcher?: Fetcher,
  caseId?: string,
  traffic?: TrafficWriter,
  emit?: Emit,
): ToolDescriptor {
  return {
    name: "http_replay",
    description: "Send an HTTP request (modify URL/parameters/header/body) and return status, length, and a body preview. Use this to test API endpoints and observe response differences.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" }, method: { type: "string" },
        headers: { type: "object" }, body: { type: "string" },
      },
      required: ["url", "method"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const req = input as ReplayRequest;
      const verdict = checkScope(req.url, scopeRules);
      if (!verdict.allowed) {
        return { ok: false, content: `out of scope: ${verdict.reason}` };
      }
      const res = await replay(req, fetcher);
      const entry = recordReplay(caseId, traffic, emit, req, res);
      const bodyPreview = truncate(res.body, MAX_BODY_PREVIEW);
      const content = entry
        ? `status=${res.status} bodyLength=${res.bodyLength}\n\ntrafficId=${entry.id}\n\nbody preview:\n${bodyPreview}`
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
): TrafficEntry | undefined {
  if (!caseId || !traffic || !emit) return undefined;
  const entry: TrafficEntry = {
    id: `traf_${randomUUID()}`,
    caseId,
    url: req.url,
    method: req.method,
    requestHeaders: req.headers ?? {},
    requestBody: req.body ?? null,
    responseStatus: res.status,
    responseBody: res.body.length > 256_000 ? res.body.slice(0, 256_000) : res.body,
    createdAt: new Date().toISOString(),
  };
  traffic.add(entry);
  emit({ type: "response_captured", entry });
  return entry;
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
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const { host, reason } = input as { host: string; reason: string };
      onPropose(host, reason);
      return { ok: true, content: `已记录扩范围建议：${host}（${reason}），待人工确认。` };
    },
  };
}
