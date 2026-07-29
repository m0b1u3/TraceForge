import { randomUUID } from "node:crypto";
import { checkScope } from "@traceforge/tool-resolver";
import {
  type TrafficEntry, type Fact, type Task, type ActionCard, type TimelineEntry,
  ActionCardSchema, classifyEndpointObservation, type RuntimeEvent, type ScopeRule,
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
          requestHeaders: entry.requestHeaders,
          responseHeaders: entry.responseHeaders,
          responseSize: entry.responseSize,
          contentType: entry.contentType,
          body: entry.responseBody && entry.responseBody.length > 12_000
            ? `${entry.responseBody.slice(0, 8_000)}\n[... ${entry.responseBody.length - 12_000} characters omitted ...]\n${entry.responseBody.slice(-4_000)}`
            : entry.responseBody,
          bodyTruncated: (entry.responseBody?.length ?? 0) > 12_000,
        }, null, 2),
      };
    },
  };
}

export interface FactWriter {
  create(caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt" | "updateCount" | "updatedAt" | "validity"> & Partial<Pick<Fact, "validity">>): Fact;
  listByCase(caseId: string): Fact[];
  getById(id: string): Fact | undefined;
  update(id: string, patch: Partial<Pick<Fact, "type" | "title" | "value" | "confidence" | "tags" | "validity" | "findingStatus" | "evidenceRefs" | "hypothesisIds" | "taskIds" | "actionIds" | "verificationSummary" | "observations">>): Fact | undefined;
}
export interface TaskWriter {
  create(caseId: string, input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt" | "updateCount">): Task;
  getById(id: string): Task | undefined;
  listByCase?(caseId: string): Task[];
  update(id: string, patch: Partial<Pick<Task, "title" | "status" | "reason" | "priority" | "blockedBy" | "triggerWhen" | "relatedFacts" | "hypothesisIds">>): Task | undefined;
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

export interface ReferenceReader {
  getById(id: string): { id: string; caseId?: string } | undefined;
}

export function makeRecordFactTool(caseId: string, facts: FactWriter, timeline: TimelineWriter, emit: Emit, runId?: string): ToolDescriptor {
  return {
    name: "record_fact",
    description: "Record an investigation fact. Use a precise domain-independent type such as api_endpoint, credential, error_signal, or finding. A new finding must start with findingStatus=candidate and must reference an existing evidence Fact, Hypothesis, Task, and Action through evidenceRefs, hypothesisIds, taskIds, and actionIds. Record preliminary observations as non-finding Facts first, then build the traceable chain before creating a finding. Include id only when updating an existing Fact.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        type: { type: "string" }, title: { type: "string" }, value: {},
        confidence: { type: "number" }, tags: { type: "array", items: { type: "string" } },
        validity: { type: "string", enum: ["valid", "conflicted", "superseded"] },
        findingStatus: { type: "string", enum: ["candidate", "validating", "verified", "needs_review", "rejected", "stale"] },
        evidenceRefs: { type: "array", items: { type: "string" } },
        hypothesisIds: { type: "array", items: { type: "string" } },
        taskIds: { type: "array", items: { type: "string" } },
        actionIds: { type: "array", items: { type: "string" } },
        verificationSummary: { type: "string" },
        observation: {
          type: "object",
          properties: {
            sourceType: { type: "string" },
            sourceRef: { type: "string" },
            identityId: { type: "string" },
            condition: { type: "string" },
            summary: { type: "string" },
          },
          required: ["sourceType", "sourceRef", "summary"],
        },
      },
      required: ["type", "title"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as {
        id?: string; type?: string; title?: string; value?: unknown; confidence?: number; tags?: string[];
        validity?: string; findingStatus?: Fact["findingStatus"]; evidenceRefs?: string[];
        hypothesisIds?: string[]; taskIds?: string[]; actionIds?: string[]; verificationSummary?: string;
        observation?: { sourceType: string; sourceRef: string; identityId?: string; condition?: string; summary: string };
      };
      if (typeof i.id === "string" && i.id) {
        if (!facts.getById(i.id)) return { ok: false, content: `fact ${i.id} 不存在，新建请去掉 id` };
        const patch: Record<string, unknown> = {};
        if (i.type !== undefined) patch.type = i.type;
        if (i.title !== undefined) patch.title = i.title;
        if (i.value !== undefined) patch.value = i.value;
        if (typeof i.confidence === "number") patch.confidence = i.confidence;
        if (Array.isArray(i.tags)) patch.tags = i.tags;
        if (i.validity === "valid" || i.validity === "conflicted" || i.validity === "superseded") patch.validity = i.validity;
        if (i.findingStatus !== undefined) patch.findingStatus = i.findingStatus;
        if (Array.isArray(i.evidenceRefs)) patch.evidenceRefs = i.evidenceRefs;
        if (Array.isArray(i.hypothesisIds)) patch.hypothesisIds = i.hypothesisIds;
        if (Array.isArray(i.taskIds)) patch.taskIds = i.taskIds;
        if (Array.isArray(i.actionIds)) patch.actionIds = i.actionIds;
        if (typeof i.verificationSummary === "string") patch.verificationSummary = i.verificationSummary;
        if (i.observation) {
          const current = facts.getById(i.id);
          patch.observations = [...(current?.observations ?? []), {
            id: `obs_${randomUUID()}`,
            sourceType: i.observation.sourceType,
            sourceRef: i.observation.sourceRef,
            runId: runId ?? null,
            identityId: i.observation.identityId ?? null,
            condition: i.observation.condition ?? "",
            summary: i.observation.summary,
            observedAt: new Date().toISOString(),
          }];
        }
        let fact: Fact | undefined;
        try {
          fact = facts.update(i.id, patch as never);
        } catch (error) {
          return { ok: false, content: (error as Error).message };
        }
        if (!fact) return { ok: false, content: `更新失败：${i.id}` };
        const entry = timeline.append(caseId, "fact_updated", `Fact 更新: ${fact.title}（第 ${fact.updateCount} 次）`, fact.id);
        emit({ type: "fact_updated", fact });
        emit({ type: "timeline_appended", entry });
        return { ok: true, content: `已更新 Fact ${fact.id}（第 ${fact.updateCount} 次）` };
      }
      let fact: Fact;
      try {
        fact = facts.create(caseId, {
          type: i.type ?? "note", title: i.title ?? "", value: i.value ?? {},
          source: { type: "ai", ref: "agent" },
          sourceRunId: runId ?? null,
          confidence: typeof i.confidence === "number" ? i.confidence : 1,
          tags: Array.isArray(i.tags) ? i.tags : [],
          findingStatus: i.findingStatus ?? (i.type === "finding" ? "candidate" : null),
          evidenceRefs: i.evidenceRefs ?? [],
          hypothesisIds: i.hypothesisIds ?? [],
          taskIds: i.taskIds ?? [],
          actionIds: i.actionIds ?? [],
          verificationSummary: i.verificationSummary ?? null,
          observations: i.observation ? [{
            id: `obs_${randomUUID()}`,
            sourceType: i.observation.sourceType,
            sourceRef: i.observation.sourceRef,
            runId: runId ?? null,
            identityId: i.observation.identityId ?? null,
            condition: i.observation.condition ?? "",
            summary: i.observation.summary,
            observedAt: new Date().toISOString(),
          }] : [],
        });
      } catch (error) {
        return { ok: false, content: (error as Error).message };
      }
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

export interface TaskCompletionGateResult {
  allowed: boolean;
  missing: string[];
}

export type TaskCompletionGate = (task: Task) => TaskCompletionGateResult;

export interface TaskStatusGateResult {
  allowed: boolean;
  message?: string;
}

export type TaskStatusGate = (current: Task, requestedStatus: Task["status"], patch: Partial<Task>) => TaskStatusGateResult;

export function makeRecordTaskTool(
  caseId: string,
  tasks: TaskWriter,
  timeline: TimelineWriter,
  emit: Emit,
  runId?: string,
  hypotheses?: ReferenceReader,
  completionGate?: TaskCompletionGate,
  statusGate?: TaskStatusGate,
): ToolDescriptor {
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
        hypothesisIds: { type: "array", items: { type: "string" } },
        priority: { type: "string" },
      },
      required: ["title"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as Record<string, unknown>;
      const hypothesisIds = Array.isArray(i.hypothesisIds)
        ? i.hypothesisIds.filter((value): value is string => typeof value === "string")
        : [];
      if (typeof i.id !== "string" && hypothesisIds.length === 0) {
        return { ok: false, content: "new Task requires at least one hypothesisIds reference" };
      }
      if (hypotheses && hypothesisIds.some((id) => {
        const hypothesis = hypotheses.getById(id);
        return !hypothesis || (hypothesis.caseId !== undefined && hypothesis.caseId !== caseId);
      })) {
        return { ok: false, content: "hypothesisIds contains an unknown Hypothesis" };
      }
      if (typeof i.id !== "string" && tasks.listByCase) {
        const normalizedTitle = String(i.title).trim().toLocaleLowerCase();
        const requestedHypotheses = [...hypothesisIds].sort();
        const duplicate = tasks.listByCase(caseId).find((task) => {
          if ((task.runId ?? null) !== (runId ?? null)) return false;
          if (["done", "failed", "rejected", "out_of_scope"].includes(task.status)) return false;
          const existingHypotheses = [...(task.hypothesisIds ?? [])].sort();
          return task.title.trim().toLocaleLowerCase() === normalizedTitle
            && existingHypotheses.length === requestedHypotheses.length
            && existingHypotheses.every((id, index) => id === requestedHypotheses[index]);
        });
        if (duplicate) {
          const gate = duplicate.relationshipGate
            ? ` It is relationship-gated by ${duplicate.relationshipGate.blockedHypothesisIds.join(", ")}; wait for the gate to clear.`
            : "";
          return { ok: true, content: `Equivalent Task already exists: ${duplicate.id} [${duplicate.status}]. Reuse it instead of creating a duplicate.${gate}` };
        }
      }
      if (typeof i.id === "string" && i.id) {
        const currentTask = tasks.getById(i.id);
        if (!currentTask) return { ok: false, content: `task ${i.id} 不存在，新建请去掉 id` };
        const patch: Record<string, unknown> = {};
        if (typeof i.title === "string") patch.title = i.title;
        if (typeof i.status === "string") patch.status = normalizeStatus(i.status);
        if (typeof i.reason === "string") patch.reason = i.reason;
        if (typeof i.priority === "string") patch.priority = normalizePriority(i.priority);
        if (Array.isArray(i.blockedBy)) patch.blockedBy = i.blockedBy;
        if (Array.isArray(i.triggerWhen)) patch.triggerWhen = i.triggerWhen;
        if (Array.isArray(i.relatedFacts)) patch.relatedFacts = i.relatedFacts;
        if (Array.isArray(i.hypothesisIds)) patch.hypothesisIds = i.hypothesisIds;
        if (statusGate) {
          const transition = statusGate(currentTask, (patch.status as Task["status"] | undefined) ?? currentTask.status, patch as Partial<Task>);
          if (!transition.allowed) return { ok: false, content: transition.message ?? "Task status transition denied" };
        }
        let completionBlocked: TaskCompletionGateResult | undefined;
        if (patch.status === "done" && completionGate) {
          const result = completionGate({ ...currentTask, ...patch } as Task);
          if (!result.allowed) {
            completionBlocked = result;
            patch.status = "blocked";
            patch.reason = `[Completion gate] ${result.missing.join("; ")}`;
            patch.triggerWhen = result.missing;
          }
        }
        const task = tasks.update(i.id, patch as never);
        if (!task) return { ok: false, content: `更新失败：${i.id}` };
        const entry = timeline.append(caseId, "task_updated", `Task 更新: ${task.title}（第 ${task.updateCount} 次）`, task.id);
        emit({ type: "task_updated", task });
        emit({ type: "timeline_appended", entry });
        if (completionBlocked) {
          return { ok: true, content: `Task ${task.id} remains blocked. Missing completion evidence: ${completionBlocked.missing.join("; ")}` };
        }
        return { ok: true, content: `已更新 Task ${task.id}（第 ${task.updateCount} 次）` };
      }
      const task = tasks.create(caseId, {
        runId: runId ?? null,
        title: String(i.title),
        status: normalizeStatus(i.status),
        reason: typeof i.reason === "string" ? i.reason : "",
        blockedBy: Array.isArray(i.blockedBy) ? (i.blockedBy as string[]) : [],
        triggerWhen: Array.isArray(i.triggerWhen) ? (i.triggerWhen as string[]) : [],
        relatedFacts: Array.isArray(i.relatedFacts) ? (i.relatedFacts as string[]) : [],
        hypothesisIds: Array.isArray(i.hypothesisIds) ? (i.hypothesisIds as string[]) : [],
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
  references?: { hypotheses: ReferenceReader; tasks: ReferenceReader },
): ToolDescriptor {
  return {
    name: "record_action",
    description: "记录一个证据驱动的测试动作。evidenceRefs 必须引用至少一个已记录的 Fact id（无证据依据的动作不被接受）。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, goal: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } },
        hypothesisRefs: { type: "array", items: { type: "string" } },
        taskRefs: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" }, steps: { type: "array", items: { type: "string" } },
        expectedResults: { type: "array", items: { type: "string" } },
        riskNotes: { type: "array", items: { type: "string" } },
        tool: { type: "string" }, priority: { type: "string" },
      },
      required: ["title", "goal", "evidenceRefs", "hypothesisRefs", "taskRefs", "reasoning", "steps", "tool"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as Record<string, unknown>;
      const refs = Array.isArray(i.evidenceRefs) ? (i.evidenceRefs as unknown[]).filter((r): r is string => typeof r === "string") : [];
      const hypothesisRefs = Array.isArray(i.hypothesisRefs) ? i.hypothesisRefs.filter((r): r is string => typeof r === "string") : [];
      const taskRefs = Array.isArray(i.taskRefs) ? i.taskRefs.filter((r): r is string => typeof r === "string") : [];
      const knownIds = new Set(facts.listByCase(caseId).map((f) => f.id));
      if (refs.length === 0 || !refs.every((r) => knownIds.has(r))) {
        return { ok: false, content: "evidenceRefs 必须非空且都引用已记录的 Fact id；请先 record_fact 再记录动作。" };
      }
      if (hypothesisRefs.length === 0 || taskRefs.length === 0) {
        return { ok: false, content: "Action requires both hypothesisRefs and taskRefs" };
      }
      if (references && (
        hypothesisRefs.some((ref) => {
          const hypothesis = references.hypotheses.getById(ref);
          return !hypothesis || (hypothesis.caseId !== undefined && hypothesis.caseId !== caseId);
        })
        || taskRefs.some((ref) => {
          const task = references.tasks.getById(ref);
          return !task || (task.caseId !== undefined && task.caseId !== caseId);
        })
      )) {
        return { ok: false, content: "Action contains an unknown Hypothesis or Task reference" };
      }
      const now = new Date().toISOString();
      const parsed = ActionCardSchema.safeParse({
        id: `action_${randomUUID()}`, caseId, title: i.title, goal: i.goal,
        evidenceRefs: refs, hypothesisRefs, taskRefs, reasoning: i.reasoning,
        steps: Array.isArray(i.steps) ? i.steps : [],
        expectedResults: Array.isArray(i.expectedResults) ? i.expectedResults : [],
        riskNotes: Array.isArray(i.riskNotes) ? i.riskNotes : [],
        tool: i.tool, priority: normalizePriority(i.priority),
        status: "approved", createdAt: now, updatedAt: now,
      });
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "action"}: ${issue.message}`)
          .join("; ");
        return { ok: false, content: `Action structure is invalid: ${issues}` };
      }
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

// ---- 黑盒 API 端点发现 ----

const STATIC_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".css", ".woff", ".woff2",
  ".ttf", ".eot", ".otf", ".mp3", ".mp4", ".webm", ".ogg", ".pdf", ".zip",
]);
const API_PATH_MARKERS = ["/api/", "/graphql", "/v1/", "/v2/", "/v3/", "/rest/", "/service", "/svc/", "/wp-json", "/ajax", "/json/", "/data/", "/endpoint"];
const LOGIN_PATH_MARKERS = ["login", "signin", "auth", "token", "session", "oauth", "callback"];

function isStatic(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    for (const ext of STATIC_EXT) {
      if (path.endsWith(ext)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function looksLikeApi(path: string, responseBody: string | null): boolean {
  const lowerPath = path.toLowerCase();
  if (API_PATH_MARKERS.some((m) => lowerPath.includes(m))) return true;
  if (LOGIN_PATH_MARKERS.some((m) => lowerPath.includes(m))) return true;
  if (responseBody) {
    const trimmed = responseBody.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  }
  return false;
}

function resolveUrl(base: string, raw: string): string | null {
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) return new URL(raw).href;
    if (raw.startsWith("//")) return new URL(`https:${raw}`).href;
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

function normalizeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    // 去查询参数与末尾斜杠，方便去重
    u.search = "";
    u.hash = "";
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    u.pathname = path;
    return u.href;
  } catch {
    return url;
  }
}

function extractPathsFromText(text: string, baseUrl: string, scopeRules: ScopeRule[]): string[] {
  const found = new Set<string>();
  // 双引号或单引号包裹的绝对/相对路径
  const quoted = /["'`](https?:\/\/[^\s"'`<>{}|\\^`\[\]]+|[/][a-zA-Z0-9_\-./]*[^\s"'`<>{}|\\^`\[\]]*)["'`]/gi;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(text)) !== null) {
    const raw = m[1];
    const resolved = resolveUrl(baseUrl, raw);
    if (!resolved) continue;
    const verdict = checkScope(resolved, scopeRules);
    if (!verdict.allowed) continue;
    found.add(normalizeEndpoint(resolved));
  }
  return Array.from(found);
}

const LLM_TEXT_LIMIT = 20000;

function verifyLlmCandidates(
  candidates: LlmEndpointCandidate[],
  sourceText: string,
  baseUrl: string,
  scopeRules: ScopeRule[],
  sourceId: string,
): Array<{ url: string; method: string; parameters: EndpointParameter[]; sourceIds: string[] }> {
  const quotedPaths = extractPathsFromText(sourceText, baseUrl, scopeRules);
  const quotedSet = new Set(quotedPaths.map(normalizeEndpoint));
  const verified: Array<{ url: string; method: string; parameters: EndpointParameter[]; sourceIds: string[] }> = [];
  for (const c of candidates) {
    const resolved = resolveUrl(baseUrl, c.url);
    if (!resolved) continue;
    const normalized = normalizeEndpoint(resolved);
    if (!quotedSet.has(normalized)) {
      const pathname = new URL(resolved).pathname;
      if (!sourceText.includes(pathname)) continue;
    }
    const validParams = (c.parameters ?? []).filter((p) => c.evidence.includes(p.name));
    const method = c.method && /^[A-Z]+$/i.test(c.method) ? c.method.toUpperCase() : "GET";
    verified.push({ url: normalized, method, parameters: validParams, sourceIds: [sourceId] });
  }
  return verified;
}

export interface EndpointParameter {
  name: string;
  required?: boolean;
  location?: "query" | "body" | "path";
  note?: string;
}

export interface LlmEndpointCandidate {
  url: string;
  method?: string;
  parameters?: EndpointParameter[];
  evidence: string;
}

export interface EndpointAnalyzer {
  (text: string, context: { sourceType: "traffic" | "js"; baseUrl?: string }): Promise<LlmEndpointCandidate[]>;
}

export interface EndpointExtractorDeps {
  traffic: TrafficReader;
  facts: FactWriter;
  timeline: TimelineWriter;
  emit: Emit;
  analyze?: EndpointAnalyzer;
}

export function makeExtractApiEndpointsTool(
  caseId: string,
  scopeRules: ScopeRule[],
  deps: EndpointExtractorDeps,
): ToolDescriptor {
  return {
    name: "extract_api_endpoints",
    description: "从已捕获的流量（或指定 trafficId 的响应体）中提取 API 端点，去重后记录为 api_endpoint 类型 Fact，并返回端点列表供后续测试。开启 deep 模式时会调用 LLM 做深度分析并尝试提取参数，但只保留有逐字证据的候选。",
    inputSchema: {
      type: "object",
      properties: {
        trafficId: { type: "string" },
        limit: { type: "number" },
        deep: { type: "boolean", description: "启用 LLM 深度分析并提取参数，可能增加 token 消耗" },
      },
    },
    risk: "normal",
    source: "builtin",
    executionMode: "parallel",
    execute: async (input) => {
      const { trafficId, limit = 50, deep = false } = input as { trafficId?: string; limit?: number; deep?: boolean };
      const entries = deps.traffic.listByCase(caseId);
      const sources = trafficId
        ? entries.filter((e) => e.id === trafficId)
        : entries.filter((e) => e.responseBody && !isStatic(e.url));
      if (sources.length === 0) return { ok: true, content: "未发现可用于提取端点的流量。" };

      const existingFacts = deps.facts.listByCase(caseId).filter((fact) => fact.validity === "valid");
      const discovered = new Map<string, {
        method: string;
        status: number | null;
        sourceIds: string[];
        parameters: EndpointParameter[];
        viaLlm: boolean;
        fromBody: boolean;
        observationKind: "endpoint" | "error_signal";
      }>();

      for (const entry of sources.slice(0, limit)) {
        // 请求 URL 本身
        const reqUrl = normalizeEndpoint(entry.url);
        const observationKind = classifyEndpointObservation(entry.responseStatus);
        if (
          observationKind !== "unsupported"
          && (looksLikeApi(new URL(entry.url).pathname, entry.responseBody) || !isStatic(entry.url))
        ) {
          const cur = discovered.get(reqUrl);
          if (cur) {
            if (!cur.sourceIds.includes(entry.id)) cur.sourceIds.push(entry.id);
            if (observationKind === "endpoint") {
              cur.method = entry.method;
              cur.status = entry.responseStatus;
              cur.observationKind = "endpoint";
            }
          } else {
            discovered.set(reqUrl, {
              method: entry.method,
              status: entry.responseStatus,
              sourceIds: [entry.id],
              parameters: [],
              viaLlm: false,
              fromBody: false,
              observationKind,
            });
          }
        }
        // 响应体中的路径
        if (!entry.responseBody) continue;
        for (const path of extractPathsFromText(entry.responseBody, entry.url, scopeRules)) {
          if (isStatic(path)) continue;
          const cur = discovered.get(path);
          if (cur) {
            if (!cur.sourceIds.includes(entry.id)) cur.sourceIds.push(entry.id);
            cur.observationKind = "endpoint";
          } else {
            discovered.set(path, {
              method: "GET",
              status: null,
              sourceIds: [entry.id],
              parameters: [],
              viaLlm: false,
              fromBody: true,
              observationKind: "endpoint",
            });
          }
        }
        // LLM 深度分析
        if (deep && deps.analyze) {
          const sourceType = isStatic(entry.url) ? "js" : "traffic";
          const candidates = await deps.analyze(entry.responseBody.slice(0, LLM_TEXT_LIMIT), { sourceType, baseUrl: entry.url });
          const verified = verifyLlmCandidates(candidates, entry.responseBody, entry.url, scopeRules, entry.id);
          for (const v of verified) {
            const cur = discovered.get(v.url);
            if (cur) {
              if (!cur.sourceIds.includes(entry.id)) cur.sourceIds.push(entry.id);
              cur.observationKind = "endpoint";
              // 该端点已由 LLM 深度分析确认，标记为 LLM 辅助
              cur.viaLlm = true;
              // 合并参数并去重
              const existingNames = new Set(cur.parameters.map((p) => p.name));
              for (const p of v.parameters) {
                if (!existingNames.has(p.name)) {
                  cur.parameters.push(p);
                  existingNames.add(p.name);
                }
              }
            } else {
              discovered.set(v.url, {
                method: v.method,
                status: null,
                sourceIds: v.sourceIds,
                parameters: v.parameters,
                viaLlm: true,
                fromBody: true,
                observationKind: "endpoint",
              });
            }
          }
        }
      }

      const recordedIds: string[] = [];
      for (const [url, info] of discovered.entries()) {
        const isLogin = LOGIN_PATH_MARKERS.some((m) => url.toLowerCase().includes(m));
        const factType = info.observationKind === "error_signal"
          ? "http_error_signal"
          : isLogin
            ? "login_endpoint"
            : "api_endpoint";
        if (existingFacts.some((fact) => fact.title === url && fact.type === factType)) continue;
        const { confidence, tags, sourceType } = info.observationKind === "error_signal"
          ? {
              confidence: 0.5,
              tags: ["auto-discovery", "black-box", "error-signal", "requires-validation"],
              sourceType: "traffic" as const,
            }
          : info.viaLlm
          ? { confidence: 0.6, tags: ["auto-discovery", "llm-assisted", "evidence-verified"], sourceType: "ai" as const }
          : info.fromBody
            ? { confidence: 0.7, tags: ["auto-discovery", "black-box", "from-body"], sourceType: "traffic" as const }
            : { confidence: 0.8, tags: ["auto-discovery", "black-box"], sourceType: "traffic" as const };
        const fact = deps.facts.create(caseId, {
          type: factType,
          title: url,
          value: {
            method: info.method,
            sampleStatus: info.status,
            sourceTrafficIds: info.sourceIds,
            parameters: info.parameters,
            evidenceClass: info.observationKind,
          },
          source: { type: sourceType, ref: info.sourceIds[0] ?? "case" },
          confidence,
          tags,
        });
        const entry = deps.timeline.append(caseId, "fact_created", `Fact (agent): ${fact.title}`, fact.id);
        deps.emit({ type: "fact_created", fact });
        deps.emit({ type: "timeline_appended", entry });
        recordedIds.push(fact.id);
      }

      const lines = Array.from(discovered.entries()).map(([url, info]) => `${info.method} ${url} (${info.status ?? "-"})`);
      return {
        ok: true,
        content: `发现 ${discovered.size} 个端点，记录 ${recordedIds.length} 条新 Fact:\n${lines.join("\n")}`,
      };
    },
  };
}
