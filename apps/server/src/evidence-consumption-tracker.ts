import type { Fact } from "@traceforge/shared";
import type { ToolExecutionReport } from "@traceforge/extension";
import type { KnowledgeRef } from "./stores/knowledge-usage-store.js";

const PASSIVE_OR_LIFECYCLE_TOOLS = new Set([
  "list_traffic",
  "get_traffic",
  "search_traffic",
  "search_facts",
  "get_fact_detail",
  "recall_conversation",
  "recall_case_knowledge",
  "get_validation_workflow_state",
  "list_artifacts",
  "plan_artifact_analysis",
  "analyze_artifact",
  "manage_artifact_limitation",
  "manage_artifact_recovery",
  "authorize_artifact_retry",
  "list_identities",
  "list_attack_paths",
  "list_security_reports",
  "update_session_state",
  "record_task",
  "manage_validation_task",
]);

interface TrackedEvidence {
  ref: KnowledgeRef;
  tokens: string[];
}

interface PendingConsumption {
  taskId: string;
  evidence: TrackedEvidence[];
  missedActions: number;
  correctionIssued: boolean;
}

export type EvidenceConsumptionObservation =
  | { type: "none" }
  | { type: "consumed"; taskId: string; refs: KnowledgeRef[]; tool: string }
  | { type: "replan"; taskId: string; refs: KnowledgeRef[]; missedActions: number }
  | { type: "closed"; taskId: string };

function collectStrings(value: unknown, output: Set<string>, depth = 0): void {
  if (depth > 5 || output.size >= 32) return;
  if (typeof value === "string") {
    const token = value.trim();
    if (token.length >= 3 && token.length <= 512) output.add(token);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, output, depth + 1);
    }
  }
}

export function artifactEvidenceForConsumption(facts: Fact[]): TrackedEvidence[] {
  return facts.map((fact) => {
    const tokens = new Set<string>([fact.id]);
    collectStrings(fact.value, tokens);
    return { ref: { kind: "fact", id: fact.id }, tokens: [...tokens] };
  });
}

function taskControl(report: ToolExecutionReport): { taskId?: string; closes: boolean } {
  if (!["record_task", "manage_validation_task"].includes(report.name)) return { closes: false };
  const input = typeof report.input === "object" && report.input !== null
    ? report.input as Record<string, unknown>
    : {};
  const taskId = typeof input.taskId === "string"
    ? input.taskId
    : typeof input.id === "string" ? input.id : undefined;
  const closes = report.name === "manage_validation_task"
    ? ["release", "complete"].includes(String(input.action))
    : ["done", "blocked", "failed", "rejected", "out_of_scope"].includes(String(input.status));
  return { taskId, closes };
}

export class EvidenceConsumptionTracker {
  private readonly pendingByTask = new Map<string, PendingConsumption>();

  constructor(private readonly replanAfterActions = 2) {}

  register(taskId: string, evidence: TrackedEvidence[]): void {
    if (evidence.length === 0) return;
    const current = this.pendingByTask.get(taskId);
    const byRef = new Map<string, TrackedEvidence>();
    for (const item of [...(current?.evidence ?? []), ...evidence]) {
      const key = `${item.ref.kind}:${item.ref.id}`;
      const previous = byRef.get(key);
      byRef.set(key, {
        ref: item.ref,
        tokens: [...new Set([...(previous?.tokens ?? []), ...item.tokens])],
      });
    }
    this.pendingByTask.set(taskId, {
      taskId,
      evidence: [...byRef.values()],
      missedActions: current?.missedActions ?? 0,
      correctionIssued: current?.correctionIssued ?? false,
    });
  }

  observe(report: ToolExecutionReport): EvidenceConsumptionObservation {
    const control = taskControl(report);
    if (control.taskId && control.closes && this.pendingByTask.delete(control.taskId)) {
      return { type: "closed", taskId: control.taskId };
    }
    if (PASSIVE_OR_LIFECYCLE_TOOLS.has(report.name)) return { type: "none" };

    const serialized = typeof report.input === "string" ? report.input : JSON.stringify(report.input ?? {});
    for (const pending of this.pendingByTask.values()) {
      const matched = pending.evidence.filter((item) =>
        item.tokens.some((token) => serialized.includes(token)));
      if (matched.length > 0) {
        this.pendingByTask.delete(pending.taskId);
        return {
          type: "consumed",
          taskId: pending.taskId,
          refs: matched.map((item) => item.ref),
          tool: report.name,
        };
      }
    }

    if (!report.ok) return { type: "none" };
    const pending = [...this.pendingByTask.values()][0];
    if (!pending) return { type: "none" };
    pending.missedActions += 1;
    if (pending.correctionIssued || pending.missedActions < this.replanAfterActions) {
      return { type: "none" };
    }
    pending.correctionIssued = true;
    return {
      type: "replan",
      taskId: pending.taskId,
      refs: pending.evidence.map((item) => item.ref),
      missedActions: pending.missedActions,
    };
  }
}
