import { keywordScore } from "@traceforge/reasoning-core";
import type { Fact, TrafficEntry, AgentEvent } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export interface FactSearchReader { listByCase(caseId: string): Fact[] }
export interface FactDetailReader { getById(id: string): Fact | undefined }
export interface TrafficSearchReader { listByCase(caseId: string): TrafficEntry[] }
export interface ConvoSearchReader { listByCase(caseId: string): AgentEvent[] }
export interface SummaryReader { latest(caseId: string): { content: string } | undefined }

function clip(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

export function makeSearchFactsTool(caseId: string, facts: FactSearchReader): ToolDescriptor {
  return {
    name: "search_facts",
    description: "按关键词检索本 Case 已记录的 Fact（接口/凭据/漏洞线索等），搜索范围含类型/标题/内容/标签。返回命中的 id+类型+标题摘要；要完整内容用 get_fact_detail(id)。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    risk: "normal", source: "builtin", executionMode: "parallel",
    execute: async (input) => {
      const { query, limit = 10 } = (input ?? {}) as { query?: string; limit?: number };
      if (!query) return { ok: false, content: "缺少 query" };
      const hits = facts.listByCase(caseId)
        .map((f) => ({ f, s: keywordScore(query, `${f.type} ${f.title} ${JSON.stringify(f.value)} ${f.tags.join(" ")}`) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
      if (hits.length === 0) return { ok: true, content: `没有匹配"${query}"的 Fact` };
      return { ok: true, content: `${hits.map((h) => `${h.f.id} [${h.f.type}] ${h.f.title}`).join("\n")}\n（用 get_fact_detail(id) 看完整内容）` };
    },
  };
}

export function makeGetFactDetailTool(caseId: string, facts: FactDetailReader): ToolDescriptor {
  void caseId;
  return {
    name: "get_fact_detail",
    description: "按 id 取一条 Fact 的完整内容（含 value/source/confidence/tags）。先用 search_facts 找到 id。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    risk: "normal", source: "builtin", executionMode: "parallel",
    execute: async (input) => {
      const { id } = (input ?? {}) as { id?: string };
      if (!id) return { ok: false, content: "缺少 id" };
      const f = facts.getById(id);
      if (!f) return { ok: false, content: `未找到 Fact ${id}` };
      return { ok: true, content: JSON.stringify({ type: f.type, title: f.title, value: f.value, source: f.source, confidence: f.confidence, tags: f.tags, validity: f.validity }, null, 2) };
    },
  };
}

export function makeSearchTrafficTool(caseId: string, traffic: TrafficSearchReader): ToolDescriptor {
  return {
    name: "search_traffic",
    description: "按关键词检索本 Case 已捕获的 HTTP 流量（搜 url/method/状态码）。返回命中的 id+method+状态+url；要 headers/body 用 get_traffic(id)。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    risk: "normal", source: "builtin", executionMode: "parallel",
    execute: async (input) => {
      const { query, limit = 10 } = (input ?? {}) as { query?: string; limit?: number };
      if (!query) return { ok: false, content: "缺少 query" };
      const hits = traffic.listByCase(caseId)
        .map((e) => ({ e, s: keywordScore(query, `${e.url} ${e.method} ${e.responseStatus ?? ""}`) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
      if (hits.length === 0) return { ok: true, content: `没有匹配"${query}"的流量` };
      return { ok: true, content: `${hits.map((h) => `${h.e.id} ${h.e.method} ${h.e.responseStatus ?? "-"} ${h.e.url}`).join("\n")}\n（用 get_traffic(id) 看 headers/body）` };
    },
  };
}

export function makeRecallConversationTool(caseId: string, events: ConvoSearchReader, summaries: SummaryReader): ToolDescriptor {
  return {
    name: "recall_conversation",
    description: "按关键词检索更早的（已滚出近期窗口的）历史对话与远期摘要。想不起之前讨论过什么时用。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    risk: "normal", source: "builtin", executionMode: "parallel",
    execute: async (input) => {
      const { query, limit = 10 } = (input ?? {}) as { query?: string; limit?: number };
      if (!query) return { ok: false, content: "缺少 query" };
      const hits = events.listByCase(caseId)
        .filter((e) => e.kind === "user" || e.kind === "text" || e.kind === "done")
        .map((e) => ({ e, s: keywordScore(query, e.text) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
      const parts: string[] = [];
      if (hits.length) parts.push(hits.map((h) => `[${h.e.kind}] ${clip(h.e.text)}`).join("\n"));
      const sum = summaries.latest(caseId);
      if (sum && keywordScore(query, sum.content) > 0) parts.push(`远期摘要相关段：${clip(sum.content, 200)}`);
      if (parts.length === 0) return { ok: true, content: `没有匹配"${query}"的历史对话` };
      return { ok: true, content: parts.join("\n\n") };
    },
  };
}
