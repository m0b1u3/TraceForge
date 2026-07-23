import type { ToolDescriptor } from "./tool.js";

export interface SessionStateWriter {
  upsert(caseId: string, patch: { currentGoal?: string; phase?: string; focus?: { host?: string; url?: string; note?: string }; activeHypothesisIds?: string[] }, runId: string): { phase: string };
}
export interface HypothesisWriter {
  create(caseId: string, input: {
    statement: string; basedOnFactIds: string[]; relatedTaskIds?: string[]; runId?: string | null;
    priorityScore?: number;
    scoreFactors?: {
      impact: number; evidenceStrength: number; verificationCost: number;
      operationRisk: number; pathRelevance: number; freshness: number;
    };
    status?: "candidate" | "active";
    reason?: string;
    relations?: {
      prerequisiteIds?: string[];
      conflictIds?: string[];
      supportIds?: string[];
      derivedFromIds?: string[];
    };
  }): { id: string; status?: string };
  getById(id: string): { id: string; status: string } | undefined;
  update(id: string, patch: { status?: string; relatedTaskIds?: string[]; statement?: string }, context?: {
    reason: string; evidenceFactIds?: string[]; kind?: "confirmed" | "refuted" | "archived" | "updated";
  }): { id: string; status: string } | undefined;
}
export interface FactReader {
  getById(id: string): { id: string } | undefined;
}

export function makeUpdateSessionStateTool(caseId: string, ss: SessionStateWriter, runId: string): ToolDescriptor {
  return {
    name: "update_session_state",
    description: "更新当前会话状态：currentGoal（你正在追的目标）、phase（recon/analyze/exploit/report）、focus（当前关注的 host/url/说明）。在目标或关注点变化时调用，帮助你和系统对齐当前在做什么。",
    inputSchema: {
      type: "object",
      properties: {
        currentGoal: { type: "string" },
        phase: { type: "string", enum: ["scope", "discover", "map", "test", "validate", "chain", "report"] },
        focus: { type: "object", properties: { host: { type: "string" }, url: { type: "string" }, note: { type: "string" } } },
      },
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const p = { ...((input ?? {}) as Record<string, unknown>) };
      // 容忍 LLM 不规范输入：focus 本应是对象 {host,url,note}，但真实 LLM 常传字符串
      // 或被序列化成 JSON 字符串。规范化为对象，避免 schema.parse 抛错导致整轮 run 失败。
      if (typeof p.focus === "string") {
        const raw = p.focus.trim();
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        p.focus = parsed && typeof parsed === "object" ? parsed : { note: raw };
      }
      const r = ss.upsert(caseId, p as Parameters<SessionStateWriter["upsert"]>[1], runId);
      return { ok: true, content: `会话状态已更新（phase=${r.phase}）` };
    },
  };
}

export function makeRecordHypothesisTool(caseId: string, hyp: HypothesisWriter, facts: FactReader, runId?: string): ToolDescriptor {
  return {
    name: "record_hypothesis",
    description: "记录一个可验证的假设（如「订单接口可能存在越权」）。必须基于已记录的 Fact（basedOnFactIds 非空且引用真实 Fact）——无证据的猜测会被拒绝。记录后应建 Task 去验证它。",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string" },
        basedOnFactIds: { type: "array", items: { type: "string" } },
        relatedTaskIds: { type: "array", items: { type: "string" } },
        relations: {
          type: "object",
          description: "Optional same-Run hypothesis relationships. Prerequisites must be confirmed before activation; conflicts cannot be active together.",
          properties: {
            prerequisiteIds: { type: "array", items: { type: "string" } },
            conflictIds: { type: "array", items: { type: "string" } },
            supportIds: { type: "array", items: { type: "string" } },
            derivedFromIds: { type: "array", items: { type: "string" } },
          },
        },
        activate: { type: "boolean" },
        priorityScore: { type: "number", minimum: 0, maximum: 100 },
        scoreFactors: {
          type: "object",
          properties: {
            impact: { type: "number", minimum: 0, maximum: 100 },
            evidenceStrength: { type: "number", minimum: 0, maximum: 100 },
            verificationCost: { type: "number", minimum: 0, maximum: 100 },
            operationRisk: { type: "number", minimum: 0, maximum: 100 },
            pathRelevance: { type: "number", minimum: 0, maximum: 100 },
            freshness: { type: "number", minimum: 0, maximum: 100 },
          },
          required: ["impact", "evidenceStrength", "verificationCost", "operationRisk", "pathRelevance", "freshness"],
        },
        reason: { type: "string", description: "Why this hypothesis is worth tracking now." },
      },
      required: ["statement", "basedOnFactIds"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const { statement, basedOnFactIds, relatedTaskIds, relations, activate, priorityScore, scoreFactors, reason } = (input ?? {}) as {
        statement?: string; basedOnFactIds?: string[]; relatedTaskIds?: string[];
        relations?: { prerequisiteIds?: string[]; conflictIds?: string[]; supportIds?: string[]; derivedFromIds?: string[] };
        activate?: boolean; priorityScore?: number;
        scoreFactors?: {
          impact: number; evidenceStrength: number; verificationCost: number;
          operationRisk: number; pathRelevance: number; freshness: number;
        };
        reason?: string;
      };
      if (!statement) return { ok: false, content: "缺少 statement" };
      if (!basedOnFactIds || basedOnFactIds.length === 0) return { ok: false, content: "假设必须基于已记录的 Fact：basedOnFactIds 不能为空。" };
      const missing = basedOnFactIds.filter((id) => !facts.getById(id));
      if (missing.length > 0) return { ok: false, content: `basedOnFactIds 引用了不存在的 Fact：${missing.join(", ")}` };
      const h = hyp.create(caseId, {
        statement, basedOnFactIds, relatedTaskIds, runId: runId ?? null,
        priorityScore, scoreFactors, relations, status: activate ? "active" : "candidate", reason,
      });
      return { ok: true, content: `已记录假设 ${h.id}：${statement}` };
    },
  };
}

export function makeResolveHypothesisTool(caseId: string, hyp: HypothesisWriter, facts: FactReader): ToolDescriptor {
  void caseId;
  return {
    name: "resolve_hypothesis",
    description: "对一个假设下结论：confirmed（已证实，须用 confirmingFactId 引用证实它的新 Fact）或 refuted（已排除）。证实的假设应转为 finding Fact 并生成 Action Card。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["confirmed", "refuted"] },
        confirmingFactId: { type: "string" },
        reason: { type: "string", description: "Evidence-based explanation for confirming or refuting this hypothesis." },
      },
      required: ["id", "status"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const { id, status, confirmingFactId, reason } = (input ?? {}) as { id?: string; status?: "confirmed" | "refuted"; confirmingFactId?: string; reason?: string };
      if (!id || !status) return { ok: false, content: "缺少 id 或 status" };
      if (!hyp.getById(id)) return { ok: false, content: `未找到假设 ${id}` };
      if (status === "confirmed") {
        if (!confirmingFactId || !facts.getById(confirmingFactId)) {
          return { ok: false, content: "确认假设须用 confirmingFactId 引用一个已记录的、证实它的 Fact。" };
        }
      }
      const r = hyp.update(id, { status }, {
        kind: status,
        reason: reason?.trim() || (status === "confirmed" ? "Confirmed by recorded evidence." : "Refuted after verification."),
        evidenceFactIds: confirmingFactId ? [confirmingFactId] : [],
      });
      return { ok: true, content: `假设 ${id} → ${r?.status}` };
    },
  };
}
