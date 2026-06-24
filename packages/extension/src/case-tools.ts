import type { TrafficEntry } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export interface TrafficReader {
  listByCase(caseId: string): TrafficEntry[];
}

export function makeListTrafficTool(caseId: string, traffic: TrafficReader): ToolDescriptor {
  return {
    name: "list_traffic",
    description: "列出本 case 已捕获的 HTTP 请求摘要（method / url / 状态码 / id）。分析前先看有哪些流量。",
    inputSchema: { type: "object", properties: {} },
    risk: "normal",
    source: "builtin",
    execute: async () => {
      const list = traffic.listByCase(caseId);
      const summary = list.map((e) => `${e.id} ${e.method} ${e.responseStatus ?? "-"} ${e.url}`).join("\n");
      return { ok: true, content: summary || "（暂无流量）" };
    },
  };
}

export function makeGetTrafficTool(caseId: string, traffic: TrafficReader): ToolDescriptor {
  return {
    name: "get_traffic",
    description: "按 id 取一条已捕获请求的详情（含 headers 与响应体）。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const { id } = input as { id: string };
      const entry = traffic.listByCase(caseId).find((e) => e.id === id);
      if (!entry) return { ok: false, content: `未找到流量 ${id}` };
      return {
        ok: true,
        content: JSON.stringify({
          url: entry.url, method: entry.method, status: entry.responseStatus,
          requestHeaders: entry.requestHeaders, body: entry.responseBody,
        }, null, 2),
      };
    },
  };
}
