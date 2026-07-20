import type { RuntimeEvent, SecurityReport } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export interface SecurityReportWriter {
  create(caseId: string, input: Omit<SecurityReport, "id" | "caseId" | "reviewStatus" | "reviewReasons" | "dependencyVersions" | "version" | "createdAt" | "updatedAt">): SecurityReport;
  update(id: string, patch: Partial<Omit<SecurityReport, "id" | "caseId" | "reviewStatus" | "reviewReasons" | "dependencyVersions" | "version" | "createdAt" | "updatedAt">>): SecurityReport | undefined;
  listByCase(caseId: string): SecurityReport[];
}

interface ReportTimeline {
  append(caseId: string, eventType: string, detail: string, refId?: string): unknown;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];

export function makeListSecurityReportsTool(caseId: string, reports: SecurityReportWriter): ToolDescriptor {
  return {
    name: "list_security_reports",
    description: "List evidence-backed security reports persisted for this case.",
    risk: "normal",
    source: "builtin",
    executionMode: "parallel",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true, content: JSON.stringify(reports.listByCase(caseId)) }),
  };
}

export function makeRecordSecurityReportTool(
  caseId: string,
  runId: string,
  reports: SecurityReportWriter,
  timeline: ReportTimeline,
  emit: (event: RuntimeEvent) => void,
): ToolDescriptor {
  return {
    name: "record_security_report",
    description: "Create or revise an evidence-backed report. Finding IDs must reference valid verified Findings; attack paths must be validated. State limitations explicitly and never add unsupported claims.",
    risk: "normal",
    source: "builtin",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        status: { type: "string", enum: ["draft", "final"] },
        executiveSummary: { type: "string" },
        scope: { type: "string" },
        methodology: { type: "string" },
        limitations: { type: "array", items: { type: "string" } },
        findingFactIds: { type: "array", items: { type: "string" }, minItems: 1 },
        attackPathIds: { type: "array", items: { type: "string" } },
        evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["title", "executiveSummary", "findingFactIds", "evidenceRefs"],
    },
    execute: async (input) => {
      const value = input as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id : undefined;
      const findingFactIds = stringList(value.findingFactIds);
      const evidenceRefs = stringList(value.evidenceRefs);
      if (!findingFactIds.length || !evidenceRefs.length) {
        return { ok: false, content: "report requires verified Finding IDs and evidence Fact references" };
      }
      const common = {
        title: String(value.title ?? ""),
        status: (value.status as SecurityReport["status"] | undefined) ?? "draft",
        executiveSummary: String(value.executiveSummary ?? ""),
        scope: String(value.scope ?? ""),
        methodology: String(value.methodology ?? ""),
        limitations: stringList(value.limitations),
        findingFactIds,
        attackPathIds: stringList(value.attackPathIds),
        evidenceRefs,
        sourceRunIds: [runId],
      };
      try {
        const existing = id ? reports.listByCase(caseId).find((report) => report.id === id) : undefined;
        const report = id
          ? reports.update(id, { ...common, sourceRunIds: [...new Set([...(existing?.sourceRunIds ?? []), runId])] })
          : reports.create(caseId, common);
        if (!report || report.caseId !== caseId) return { ok: false, content: "security report not found in this case" };
        const type = id ? "security_report_updated" : "security_report_created";
        timeline.append(caseId, type, `${report.title} [${report.status}] v${report.version}`, report.id);
        emit({ type, report });
        return { ok: true, content: JSON.stringify(report) };
      } catch (error) {
        return { ok: false, content: (error as Error).message };
      }
    },
  };
}
