import type { ToolExecutionReport } from "@traceforge/extension";

const PASSIVE_TOOLS = new Set([
  "list_traffic",
  "get_traffic",
  "search_traffic",
  "search_facts",
  "get_fact_detail",
  "recall_conversation",
  "recall_case_knowledge",
  "get_validation_workflow_state",
  "list_identities",
  "list_attack_paths",
  "list_security_reports",
  "update_session_state",
]);

const STRUCTURE_TOOLS = new Set([
  "record_fact",
  "record_hypothesis",
  "resolve_hypothesis",
  "record_task",
  "manage_validation_task",
  "record_action",
  "record_identity",
  "record_attack_path",
  "record_security_report",
  "record_validation_conclusion",
  "propose_scope_expansion",
]);

export function isInvestigationStructureTool(toolName: string): boolean {
  return STRUCTURE_TOOLS.has(toolName);
}

const TERMINAL_TASK_STATUSES = new Set(["done", "blocked", "rejected", "cancelled"]);

export class InvestigationStructurePolicy {
  private unstructuredActions = 0;

  constructor(private readonly maxUnstructuredActions = 8) {}

  requiresStructuredTask(toolName: string): boolean {
    return !PASSIVE_TOOLS.has(toolName) && !isInvestigationStructureTool(toolName);
  }

  authorize(toolName: string, actionableTaskCount: number, runningTaskCount: number): string | undefined {
    if (PASSIVE_TOOLS.has(toolName) || isInvestigationStructureTool(toolName)) return undefined;
    if (actionableTaskCount > 0) {
      if (runningTaskCount === 1) return undefined;
      if (runningTaskCount > 1) {
        return "Multiple investigation tasks are running. Resolve the invalid state before executing more tools.";
      }
      return "Investigation tasks are queued but none owns execution. Start exactly one task before executing this tool.";
    }
    if (this.unstructuredActions < this.maxUnstructuredActions) {
      this.unstructuredActions += 1;
      return undefined;
    }
    return [
      `The initial exploration window of ${this.maxUnstructuredActions} active actions is complete.`,
      "Before more active testing, record a concrete hypothesis and one task that states the evidence gap.",
      "This does not end the Run; it converts open exploration into an auditable investigation track.",
    ].join(" ");
  }

  observe(report: ToolExecutionReport): void {
    if (!report.ok || !["record_task", "manage_validation_task"].includes(report.name)) return;
    const input = typeof report.input === "object" && report.input !== null
      ? report.input as Record<string, unknown>
      : {};
    if (typeof input.status === "string" && TERMINAL_TASK_STATUSES.has(input.status)) {
      this.unstructuredActions = 0;
    }
    if (report.name === "manage_validation_task" && input.action === "release") {
      this.unstructuredActions = 0;
    }
  }
}

export interface LowYieldSignal {
  count: number;
  signature: string;
  steering: string;
}

export class InvestigationOutcomePolicy {
  private lastSignature = "";
  private consecutive = 0;
  private lastEmittedAt = 0;

  constructor(private readonly threshold = 6) {}

  observe(report: ToolExecutionReport): LowYieldSignal | undefined {
    const signature = lowYieldSignature(report);
    if (!signature) {
      if (report.ok && isInvestigationStructureTool(report.name)) this.reset();
      return undefined;
    }
    if (signature === this.lastSignature) this.consecutive += 1;
    else {
      this.lastSignature = signature;
      this.consecutive = 1;
      this.lastEmittedAt = 0;
    }
    if (this.consecutive < this.threshold || this.consecutive === this.lastEmittedAt) return undefined;
    this.lastEmittedAt = this.consecutive;
    return {
      count: this.consecutive,
      signature,
      steering: [
        `[Low-yield investigation outcome] ${this.consecutive} consecutive active requests produced ${signature}.`,
        "Do not treat successful tool execution as investigative progress.",
        "Stop issuing equivalent variants. Record the exhausted approach, update the current task or hypothesis, and pivot to a different evidence gap.",
      ].join(" "),
    };
  }

  private reset(): void {
    this.lastSignature = "";
    this.consecutive = 0;
    this.lastEmittedAt = 0;
  }
}

function lowYieldSignature(report: ToolExecutionReport): string | undefined {
  if (!report.ok || !["http_replay", "replay_traffic"].includes(report.name)) return undefined;
  const status = report.meta?.status;
  if (typeof status !== "number") return undefined;
  if ([400, 404, 405].includes(status)) return `HTTP ${status} without a new differential`;
  return undefined;
}
