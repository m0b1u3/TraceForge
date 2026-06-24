import { randomUUID } from "node:crypto";
import {
  type TrafficEntry, type Fact, type Task, type ActionCard, type TimelineEntry,
  ActionCardSchema, type RuntimeEvent,
} from "@traceforge/shared";
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

export interface FactWriter {
  create(caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt">): Fact;
  listByCase(caseId: string): Fact[];
}
export interface TaskWriter {
  create(caseId: string, input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt">): Task;
}
export interface ActionWriter {
  create(a: ActionCard): ActionCard;
}
export interface DecisionWriter {
  create(caseId: string, input: { decision: string; basedOn: string[]; reasoning: string; actionRef?: string | null; result?: string | null; newFacts?: string[] }): unknown;
}
export interface TimelineWriter {
  append(caseId: string, eventType: string, detail: string, refId?: string): TimelineEntry;
}
export type Emit = (e: RuntimeEvent) => void;

export function makeRecordFactTool(caseId: string, facts: FactWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor {
  return {
    name: "record_fact",
    description: "把一个发现记录为 Fact。type 用最贴切的英文标识（如 api_endpoint、graphql_endpoint、credential、finding 等，不限于预设）。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" }, title: { type: "string" }, value: {},
        confidence: { type: "number" }, tags: { type: "array", items: { type: "string" } },
      },
      required: ["type", "title"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as { type: string; title: string; value?: unknown; confidence?: number; tags?: string[] };
      const fact = facts.create(caseId, {
        type: i.type, title: i.title, value: i.value ?? {},
        source: { type: "ai", ref: "agent" },
        confidence: typeof i.confidence === "number" ? i.confidence : 1,
        tags: Array.isArray(i.tags) ? i.tags : [],
      });
      const entry = timeline.append(caseId, "fact_created", `Fact (agent): ${fact.title}`, fact.id);
      emit({ type: "fact_created", fact });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `已记录 Fact ${fact.id}: ${fact.title}` };
    },
  };
}

export function makeRecordTaskTool(caseId: string, tasks: TaskWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor {
  return {
    name: "record_task",
    description: "记录一个待办/挂起任务。可设 status=blocked + triggerWhen 表示等待某条件（如等凭据）。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, status: { type: "string" }, reason: { type: "string" },
        blockedBy: { type: "array", items: { type: "string" } },
        triggerWhen: { type: "array", items: { type: "string" } },
        relatedFacts: { type: "array", items: { type: "string" } },
        priority: { type: "string" },
      },
      required: ["title"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as Record<string, unknown>;
      const task = tasks.create(caseId, {
        title: String(i.title),
        status: (typeof i.status === "string" ? i.status : "open") as Task["status"],
        reason: typeof i.reason === "string" ? i.reason : "",
        blockedBy: Array.isArray(i.blockedBy) ? (i.blockedBy as string[]) : [],
        triggerWhen: Array.isArray(i.triggerWhen) ? (i.triggerWhen as string[]) : [],
        relatedFacts: Array.isArray(i.relatedFacts) ? (i.relatedFacts as string[]) : [],
        priority: (typeof i.priority === "string" ? i.priority : "medium") as Task["priority"],
      });
      const entry = timeline.append(caseId, "task_created", `Task (agent): ${task.title}`, task.id);
      emit({ type: "task_created", task });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `已记录 Task ${task.id}: ${task.title}` };
    },
  };
}

export function makeRecordActionTool(
  caseId: string, facts: FactWriter, actions: ActionWriter, decisions: DecisionWriter,
  timeline: TimelineWriter, emit: Emit,
): ToolDescriptor {
  return {
    name: "record_action",
    description: "记录一个证据驱动的测试动作。evidenceRefs 必须引用至少一个已记录的 Fact id（无证据依据的动作不被接受）。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, goal: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" }, steps: { type: "array", items: { type: "string" } },
        expectedResults: { type: "array", items: { type: "string" } },
        riskNotes: { type: "array", items: { type: "string" } },
        tool: { type: "string" }, priority: { type: "string" },
      },
      required: ["title", "goal", "evidenceRefs", "reasoning", "steps", "tool"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as Record<string, unknown>;
      const refs = Array.isArray(i.evidenceRefs) ? (i.evidenceRefs as unknown[]).filter((r): r is string => typeof r === "string") : [];
      const knownIds = new Set(facts.listByCase(caseId).map((f) => f.id));
      if (refs.length === 0 || !refs.every((r) => knownIds.has(r))) {
        return { ok: false, content: "evidenceRefs 必须非空且都引用已记录的 Fact id；请先 record_fact 再记录动作。" };
      }
      const now = new Date().toISOString();
      const parsed = ActionCardSchema.safeParse({
        id: `action_${randomUUID()}`, caseId, title: i.title, goal: i.goal,
        evidenceRefs: refs, reasoning: i.reasoning,
        steps: Array.isArray(i.steps) ? i.steps : [],
        expectedResults: Array.isArray(i.expectedResults) ? i.expectedResults : [],
        riskNotes: Array.isArray(i.riskNotes) ? i.riskNotes : [],
        tool: i.tool, priority: typeof i.priority === "string" ? i.priority : "medium",
        status: "approved", createdAt: now, updatedAt: now,
      });
      if (!parsed.success) return { ok: false, content: "动作结构不合法。" };
      const action = actions.create(parsed.data);
      decisions.create(caseId, {
        decision: action.title, basedOn: action.evidenceRefs, reasoning: action.reasoning,
        actionRef: action.id, result: null, newFacts: [],
      });
      const entry = timeline.append(caseId, "action_recorded", `Action (agent): ${action.title}`, action.id);
      emit({ type: "action_recorded", action });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `已记录 Action ${action.id}: ${action.title}` };
    },
  };
}
