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
    executionMode: "parallel",
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
    executionMode: "parallel",
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
  create(caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt" | "updateCount" | "updatedAt" | "validity"> & Partial<Pick<Fact, "validity">>): Fact;
  listByCase(caseId: string): Fact[];
  getById(id: string): Fact | undefined;
  update(id: string, patch: Partial<Pick<Fact, "type" | "title" | "value" | "confidence" | "tags" | "validity">>): Fact | undefined;
}
export interface TaskWriter {
  create(caseId: string, input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt" | "updateCount">): Task;
  getById(id: string): Task | undefined;
  update(id: string, patch: Partial<Pick<Task, "title" | "status" | "reason" | "priority" | "blockedBy" | "triggerWhen" | "relatedFacts">>): Task | undefined;
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
    description: "把一个发现记录为 Fact。type 用最贴切的英文标识（如 api_endpoint、graphql_endpoint、credential、finding 等，不限于预设）。要更新已有 Fact（如证据增强、置信度变化、标记 validity=superseded）时带上它的 id；新建则不带 id。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        type: { type: "string" }, title: { type: "string" }, value: {},
        confidence: { type: "number" }, tags: { type: "array", items: { type: "string" } },
        validity: { type: "string", enum: ["valid", "superseded"] },
      },
      required: ["type", "title"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as { id?: string; type?: string; title?: string; value?: unknown; confidence?: number; tags?: string[]; validity?: string };
      if (typeof i.id === "string" && i.id) {
        if (!facts.getById(i.id)) return { ok: false, content: `fact ${i.id} 不存在，新建请去掉 id` };
        const patch: Record<string, unknown> = {};
        if (i.type !== undefined) patch.type = i.type;
        if (i.title !== undefined) patch.title = i.title;
        if (i.value !== undefined) patch.value = i.value;
        if (typeof i.confidence === "number") patch.confidence = i.confidence;
        if (Array.isArray(i.tags)) patch.tags = i.tags;
        if (i.validity === "valid" || i.validity === "superseded") patch.validity = i.validity;
        const fact = facts.update(i.id, patch as never);
        if (!fact) return { ok: false, content: `更新失败：${i.id}` };
        const entry = timeline.append(caseId, "fact_updated", `Fact 更新: ${fact.title}（第 ${fact.updateCount} 次）`, fact.id);
        emit({ type: "fact_updated", fact });
        emit({ type: "timeline_appended", entry });
        return { ok: true, content: `已更新 Fact ${fact.id}（第 ${fact.updateCount} 次）` };
      }
      const fact = facts.create(caseId, {
        type: i.type ?? "note", title: i.title ?? "", value: i.value ?? {},
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

const TASK_STATUSES = new Set<Task["status"]>([
  "open", "blocked", "recheck_candidate", "approved", "running", "done", "failed", "rejected", "out_of_scope",
]);

// LLM 可能给闭 enum 外的值（如 priority:"critical"、status:"maybe"）；归一而非崩溃。
function normalizePriority(v: unknown): Task["priority"] {
  if (v === "low" || v === "medium" || v === "high") return v;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "critical" || s === "urgent" || s === "highest" || s === "p0") return "high";
    if (s === "lowest" || s === "trivial" || s === "p3") return "low";
  }
  return "medium";
}
function normalizeStatus(v: unknown): Task["status"] {
  return typeof v === "string" && TASK_STATUSES.has(v as Task["status"]) ? (v as Task["status"]) : "open";
}

export function makeRecordTaskTool(caseId: string, tasks: TaskWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor {
  return {
    name: "record_task",
    description: "记录一个待办/挂起任务。可设 status=blocked + triggerWhen 表示等待某条件（如等凭据）。要更新已有 Task（改状态/标题/原因等）时带上它的 id；新建则不带 id。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
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
      if (typeof i.id === "string" && i.id) {
        if (!tasks.getById(i.id)) return { ok: false, content: `task ${i.id} 不存在，新建请去掉 id` };
        const patch: Record<string, unknown> = {};
        if (typeof i.title === "string") patch.title = i.title;
        if (typeof i.status === "string") patch.status = normalizeStatus(i.status);
        if (typeof i.reason === "string") patch.reason = i.reason;
        if (typeof i.priority === "string") patch.priority = normalizePriority(i.priority);
        if (Array.isArray(i.blockedBy)) patch.blockedBy = i.blockedBy;
        if (Array.isArray(i.triggerWhen)) patch.triggerWhen = i.triggerWhen;
        if (Array.isArray(i.relatedFacts)) patch.relatedFacts = i.relatedFacts;
        const task = tasks.update(i.id, patch as never);
        if (!task) return { ok: false, content: `更新失败：${i.id}` };
        const entry = timeline.append(caseId, "task_updated", `Task 更新: ${task.title}（第 ${task.updateCount} 次）`, task.id);
        emit({ type: "task_updated", task });
        emit({ type: "timeline_appended", entry });
        return { ok: true, content: `已更新 Task ${task.id}（第 ${task.updateCount} 次）` };
      }
      const task = tasks.create(caseId, {
        title: String(i.title),
        status: normalizeStatus(i.status),
        reason: typeof i.reason === "string" ? i.reason : "",
        blockedBy: Array.isArray(i.blockedBy) ? (i.blockedBy as string[]) : [],
        triggerWhen: Array.isArray(i.triggerWhen) ? (i.triggerWhen as string[]) : [],
        relatedFacts: Array.isArray(i.relatedFacts) ? (i.relatedFacts as string[]) : [],
        priority: normalizePriority(i.priority),
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

export interface TaskStatusReader {
  getById(taskId: string): { id: string; title: string; status: string } | undefined;
}
export interface StatusWriter {
  updateStatus(id: string, status: string, reason: string): { id: string; caseId: string; title: string; status: string } | undefined;
}

// 校验 evidenceRefs 非空且都引用已记录 Fact（复用 record_action 规则）
function evidenceValid(caseId: string, facts: FactWriter, input: unknown): { ok: true; refs: string[] } | { ok: false } {
  const i = input as Record<string, unknown>;
  const refs = Array.isArray(i.evidenceRefs) ? (i.evidenceRefs as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const known = new Set(facts.listByCase(caseId).map((f) => f.id));
  return refs.length > 0 && refs.every((r) => known.has(r)) ? { ok: true, refs } : { ok: false };
}

export function makeReopenTaskTool(
  caseId: string, tasksR: TaskStatusReader, tasksW: StatusWriter, facts: FactWriter, timeline: TimelineWriter, emit: Emit,
): ToolDescriptor {
  return {
    name: "reopen_task",
    description: "当新证据使一个未完成（blocked/failed/open）的旧任务重新可做时，把它重启为 recheck_candidate。evidenceRefs 必须引用支撑此判断的已记录 Fact。已完成(done)的任务请改用 revert_done_task。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, reason: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } },
      required: ["taskId", "reason", "evidenceRefs"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as { taskId: string; reason: string };
      const task = tasksR.getById(i.taskId);
      if (!task) return { ok: false, content: `task not found: ${i.taskId}` };
      if (task.status === "done") return { ok: false, content: "已完成任务请用 revert_done_task" };
      const ev = evidenceValid(caseId, facts, input);
      if (!ev.ok) return { ok: false, content: "evidenceRefs 必须非空且都引用已记录的 Fact id" };
      tasksW.updateStatus(i.taskId, "recheck_candidate", i.reason);
      const updated = { id: task.id, caseId, title: task.title, status: "recheck_candidate", reason: i.reason, blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "medium", createdAt: "", updatedAt: new Date().toISOString() } as unknown as Task;
      const entry = timeline.append(caseId, "task_reopened", `Task 重启: ${task.title} ← ${i.reason}`, task.id);
      emit({ type: "task_updated", task: updated });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `Task ${task.title} 已重启为 recheck_candidate` };
    },
  };
}

export function makeRevertDoneTaskTool(
  caseId: string, tasksR: TaskStatusReader, tasksW: StatusWriter, facts: FactWriter, timeline: TimelineWriter, emit: Emit,
): ToolDescriptor {
  return {
    name: "revert_done_task",
    description: "当新证据与一个已完成(done)任务的结论矛盾时，把它打回 recheck_candidate 重新核查。这是推翻已完成结论的高风险操作，需人工确认。evidenceRefs 必须引用支撑此判断的已记录 Fact。未完成的任务请用 reopen_task。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, reason: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } },
      required: ["taskId", "reason", "evidenceRefs"],
    },
    risk: "command",
    source: "builtin",
    execute: async (input) => {
      const i = input as { taskId: string; reason: string };
      const task = tasksR.getById(i.taskId);
      if (!task) return { ok: false, content: `task not found: ${i.taskId}` };
      if (task.status !== "done") return { ok: false, content: "未完成任务请用 reopen_task" };
      const ev = evidenceValid(caseId, facts, input);
      if (!ev.ok) return { ok: false, content: "evidenceRefs 必须非空且都引用已记录的 Fact id" };
      tasksW.updateStatus(i.taskId, "recheck_candidate", i.reason);
      const updated = { id: task.id, caseId, title: task.title, status: "recheck_candidate", reason: i.reason, blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "medium", createdAt: "", updatedAt: new Date().toISOString() } as unknown as Task;
      const entry = timeline.append(caseId, "task_reverted", `Task 打回: ${task.title}（done→recheck）← ${i.reason}`, task.id);
      emit({ type: "task_updated", task: updated });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `Task ${task.title} 已打回 recheck_candidate` };
    },
  };
}
