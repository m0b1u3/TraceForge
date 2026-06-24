import { replay, type Fetcher, type ReplayRequest } from "@traceforge/tools";
import { checkScope } from "@traceforge/tool-resolver";
import type { ScopeRule } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export function makeHttpReplayTool(scopeRules: ScopeRule[], fetcher?: Fetcher): ToolDescriptor {
  return {
    name: "http_replay",
    description: "重发一个 HTTP 请求（可改 URL/参数/header/body），返回响应状态与长度。用于验证接口行为差异。",
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
      return { ok: true, content: `status=${res.status} bodyLength=${res.bodyLength}`, meta: { status: res.status } };
    },
  };
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
