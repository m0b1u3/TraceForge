import { randomUUID } from "node:crypto";
import type { AttackPath, AttackPathStep, RuntimeEvent } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export interface AttackPathWriter {
  create(caseId: string, input: Omit<AttackPath, "id" | "caseId" | "version" | "createdAt" | "updatedAt">): AttackPath;
  update(id: string, patch: Partial<Omit<AttackPath, "id" | "caseId" | "sourceRunId" | "version" | "createdAt" | "updatedAt">>): AttackPath | undefined;
  getById(id: string): AttackPath | undefined;
  listByCase(caseId: string): AttackPath[];
}

interface AttackPathTimeline {
  append(caseId: string, eventType: string, detail: string, refId?: string): unknown;
}

type Emit = (event: RuntimeEvent) => void;

function normalizeSteps(value: unknown): AttackPathStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const step = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
    return {
      id: typeof step.id === "string" && step.id ? step.id : `step_${randomUUID()}`,
      order: typeof step.order === "number" ? step.order : index,
      kind: step.kind as AttackPathStep["kind"],
      title: typeof step.title === "string" ? step.title : "",
      description: typeof step.description === "string" ? step.description : "",
      status: (step.status as AttackPathStep["status"] | undefined) ?? "proposed",
      identityId: typeof step.identityId === "string" ? step.identityId : null,
      trafficId: typeof step.trafficId === "string" ? step.trafficId : null,
      factIds: Array.isArray(step.factIds) ? step.factIds.filter((id): id is string => typeof id === "string") : [],
      taskId: typeof step.taskId === "string" ? step.taskId : null,
      actionId: typeof step.actionId === "string" ? step.actionId : null,
      prerequisiteStepIds: Array.isArray(step.prerequisiteStepIds)
        ? step.prerequisiteStepIds.filter((id): id is string => typeof id === "string")
        : [],
      validation: typeof step.validation === "string" ? step.validation : "",
    };
  });
}

const STEP_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Keep this stable when updating an existing step." },
    order: { type: "integer", minimum: 0 },
    kind: { type: "string", enum: ["access", "identity_transition", "request", "exploit", "privilege", "pivot", "impact"] },
    title: { type: "string" },
    description: { type: "string" },
    status: { type: "string", enum: ["proposed", "observed", "verified", "blocked", "refuted"] },
    identityId: { type: "string" },
    trafficId: { type: "string" },
    factIds: { type: "array", items: { type: "string" } },
    taskId: { type: "string" },
    actionId: { type: "string" },
    prerequisiteStepIds: { type: "array", items: { type: "string" } },
    validation: { type: "string" },
  },
  required: ["kind", "title"],
} as const;

export function makeListAttackPathsTool(caseId: string, paths: AttackPathWriter): ToolDescriptor {
  return {
    name: "list_attack_paths",
    description: "List persistent attack paths for this case, including paths created by earlier runs.",
    risk: "normal",
    source: "builtin",
    executionMode: "parallel",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true, content: JSON.stringify(paths.listByCase(caseId)) }),
  };
}

export function makeRecordAttackPathTool(
  caseId: string,
  runId: string,
  paths: AttackPathWriter,
  timeline: AttackPathTimeline,
  emit: Emit,
): ToolDescriptor {
  return {
    name: "record_attack_path",
    description: "Create or advance a persistent, evidence-linked attack path. Supply id to update a path from this or an earlier run. Verified steps require Fact evidence; validated paths require all steps verified plus evidence and a Finding.",
    risk: "normal",
    source: "builtin",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        objective: { type: "string" },
        status: { type: "string", enum: ["exploring", "blocked", "validated", "invalidated"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        entryIdentityId: { type: "string" },
        targetAssetFactId: { type: "string" },
        findingFactIds: { type: "array", items: { type: "string" } },
        hypothesisIds: { type: "array", items: { type: "string" } },
        evidenceRefs: { type: "array", items: { type: "string" } },
        breakpoint: { type: "string", description: "Concrete missing condition or next verification point when blocked." },
        steps: { type: "array", items: STEP_SCHEMA, minItems: 1 },
      },
      required: ["title", "objective", "steps"],
    },
    execute: async (input) => {
      const value = input as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id : undefined;
      const steps = normalizeSteps(value.steps);
      if (steps.length === 0 || steps.some((step) => !step.title || !step.kind)) {
        return { ok: false, content: "attack path requires at least one step with kind and title" };
      }
      const hypothesisIds = Array.isArray(value.hypothesisIds) ? value.hypothesisIds.filter((ref): ref is string => typeof ref === "string") : [];
      const evidenceRefs = Array.isArray(value.evidenceRefs) ? value.evidenceRefs.filter((ref): ref is string => typeof ref === "string") : [];
      if (!id && hypothesisIds.length === 0 && evidenceRefs.length === 0) {
        return { ok: false, content: "new attack path requires at least one Hypothesis or evidence Fact reference" };
      }
      try {
        const common = {
          title: String(value.title ?? ""),
          objective: String(value.objective ?? ""),
          status: (value.status as AttackPath["status"] | undefined) ?? "exploring",
          confidence: typeof value.confidence === "number" ? value.confidence : 0.5,
          lastRunId: runId,
          entryIdentityId: typeof value.entryIdentityId === "string" ? value.entryIdentityId : null,
          targetAssetFactId: typeof value.targetAssetFactId === "string" ? value.targetAssetFactId : null,
          findingFactIds: Array.isArray(value.findingFactIds) ? value.findingFactIds.filter((ref): ref is string => typeof ref === "string") : [],
          hypothesisIds,
          evidenceRefs,
          breakpoint: typeof value.breakpoint === "string" && value.breakpoint ? value.breakpoint : null,
          steps,
        };
        const attackPath = id
          ? paths.update(id, common)
          : paths.create(caseId, { ...common, sourceRunId: runId });
        if (!attackPath || attackPath.caseId !== caseId) return { ok: false, content: "attack path not found in this case" };
        const type = id ? "attack_path_updated" : "attack_path_created";
        timeline.append(caseId, type, `${attackPath.title} [${attackPath.status}] v${attackPath.version}`, attackPath.id);
        emit({ type, attackPath });
        return { ok: true, content: JSON.stringify(attackPath) };
      } catch (error) {
        return { ok: false, content: (error as Error).message };
      }
    },
  };
}
