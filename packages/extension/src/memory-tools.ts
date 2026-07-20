import { expandedKeywordSearch, keywordScore, type SharedKnowledgeContext } from "@traceforge/reasoning-core";
import type { Fact, TrafficEntry, AgentEvent } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";
import type { QueryExpander } from "./query-expander.js";

export interface FactSearchReader { listByCase(caseId: string): Fact[] }
export interface FactDetailReader { getById(id: string): Fact | undefined }
export interface TrafficSearchReader { listByCase(caseId: string): TrafficEntry[] }
export interface ConvoSearchReader { listByCase(caseId: string): AgentEvent[] }
export interface SummaryReader { latest(caseId: string): { content: string } | undefined }
export interface MemoryToolOptions { expander?: QueryExpander }
export interface SharedKnowledgeReader { get(query?: string): SharedKnowledgeContext }

function clip(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

async function expandQuery(options: MemoryToolOptions | undefined, caseId: string, toolName: string, query: string): Promise<string[]> {
  return options?.expander?.expand({ caseId, toolName, query }) ?? [query];
}

export function makeSearchFactsTool(caseId: string, facts: FactSearchReader, options: MemoryToolOptions = {}): ToolDescriptor {
  return {
    name: "search_facts",
    description: "按关键词检索本 Case 已记录的 Fact（接口/凭据/漏洞线索等），搜索范围含类型/标题/内容/标签。返回命中的 id+类型+标题摘要；要完整内容用 get_fact_detail(id)。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, includeInvalid: { type: "boolean", description: "Include conflicted, superseded, stale, rejected, and needs-review facts for deliberate re-evaluation." } }, required: ["query"] },
    risk: "normal", source: "builtin", executionMode: "parallel",
    execute: async (input) => {
      const { query, limit = 10, includeInvalid = false } = (input ?? {}) as { query?: string; limit?: number; includeInvalid?: boolean };
      if (!query) return { ok: false, content: "缺少 query" };
      const terms = await expandQuery(options, caseId, "search_facts", query);
      const hits = expandedKeywordSearch(
        facts.listByCase(caseId).filter((fact) => includeInvalid || (
          fact.validity === "valid" && !["needs_review", "rejected", "stale"].includes(fact.findingStatus ?? "")
        )),
        terms,
        (f) => `${f.type} ${f.title} ${JSON.stringify(f.value)} ${f.tags.join(" ")}`,
        { originalQuery: query, limit },
      );
      if (hits.length === 0) return { ok: true, content: `没有匹配"${query}"的 Fact\n已尝试扩展词：${terms.join(", ")}` };
      return {
        ok: true,
        content: `${hits.map((h) => {
          const matched = h.matchedTerms.length ? `\n  matched: ${h.matchedTerms.join(", ")}` : "";
          return `${h.item.id} [${h.item.type}] [${h.item.validity}${h.item.findingStatus ? `/${h.item.findingStatus}` : ""}] ${h.item.title}${matched}`;
        }).join("\n")}\n（用 get_fact_detail(id) 看完整内容）`,
      };
    },
  };
}

export function makeGetFactDetailTool(caseId: string, facts: FactDetailReader): ToolDescriptor {
  return {
    name: "get_fact_detail",
    description: "按 id 取一条 Fact 的完整内容（含 value/source/confidence/tags）。先用 search_facts 找到 id。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    risk: "normal", source: "builtin", executionMode: "parallel",
    execute: async (input) => {
      const { id } = (input ?? {}) as { id?: string };
      if (!id) return { ok: false, content: "缺少 id" };
      const f = facts.getById(id);
      if (!f || f.caseId !== caseId) return { ok: false, content: `未找到 Fact ${id}` };
      return { ok: true, content: JSON.stringify({ type: f.type, title: f.title, value: f.value, source: f.source, confidence: f.confidence, tags: f.tags, validity: f.validity }, null, 2) };
    },
  };
}

export function makeRecallCaseKnowledgeTool(reader: SharedKnowledgeReader): ToolDescriptor {
  return {
    name: "recall_case_knowledge",
    description: "读取跨 Run 的可信项目知识摘要：已验证 Findings、active Identities、非 invalidated Attack Paths 和历史失败。冲突/过期知识只返回隔离数量，不作为结论注入。",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional temporary focus used to rerank trusted project knowledge." } } },
    risk: "normal", source: "builtin", executionMode: "parallel",
    execute: async (input) => {
      const query = typeof (input as { query?: unknown } | undefined)?.query === "string" ? (input as { query: string }).query : undefined;
      return { ok: true, content: JSON.stringify(reader.get(query), null, 2) };
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

export function makeRecallConversationTool(caseId: string, events: ConvoSearchReader, summaries: SummaryReader, options: MemoryToolOptions = {}): ToolDescriptor {
  return {
    name: "recall_conversation",
    description: "按关键词检索更早的（已滚出近期窗口的）历史对话与远期摘要。想不起之前讨论过什么时用。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    risk: "normal", source: "builtin", executionMode: "parallel",
    execute: async (input) => {
      const { query, limit = 10 } = (input ?? {}) as { query?: string; limit?: number };
      if (!query) return { ok: false, content: "缺少 query" };
      const terms = await expandQuery(options, caseId, "recall_conversation", query);
      const hits = expandedKeywordSearch(
        events.listByCase(caseId).filter((e) => e.kind === "user" || e.kind === "text" || e.kind === "done"),
        terms,
        (e) => e.text,
        { originalQuery: query, limit },
      );
      const parts: string[] = [];
      if (hits.length) parts.push(hits.map((h) => `[${h.item.kind}] ${clip(h.item.text)}`).join("\n"));
      const sum = summaries.latest(caseId);
      if (sum && expandedKeywordSearch([sum], terms, (s) => s.content, { originalQuery: query, limit: 1 }).length > 0) {
        parts.push(`远期摘要相关段：${clip(sum.content, 200)}`);
      }
      if (parts.length === 0) return { ok: true, content: `没有匹配"${query}"的历史对话\n已尝试扩展词：${terms.join(", ")}` };
      return { ok: true, content: parts.join("\n\n") };
    },
  };
}
