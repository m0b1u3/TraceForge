import type { AttackPath, Fact, SecurityReport } from "@traceforge/shared";
import type { Db } from "./db/client.js";
import { AttackPathStore } from "./stores/attack-path-store.js";
import { FactStore } from "./stores/fact-store.js";
import { SecurityReportStore } from "./stores/security-report-store.js";

export interface SecurityReportExport {
  schemaVersion: 1;
  exportedAt: string;
  report: SecurityReport;
  findings: Fact[];
  evidence: Fact[];
  attackPaths: AttackPath[];
}

export function securityReportExport(db: Db, reportId: string, exportedAt = new Date().toISOString()): SecurityReportExport | undefined {
  const report = new SecurityReportStore(db).getById(reportId);
  if (!report) return undefined;
  const caseFacts = new FactStore(db).listByCase(report.caseId);
  const factsById = new Map(caseFacts.map((fact) => [fact.id, fact]));
  const pathsById = new Map(new AttackPathStore(db).listByCase(report.caseId).map((path) => [path.id, path]));
  return {
    schemaVersion: 1,
    exportedAt,
    report,
    findings: report.findingFactIds.flatMap((id) => factsById.get(id) ? [factsById.get(id)!] : []),
    evidence: report.evidenceRefs.flatMap((id) => factsById.get(id) ? [factsById.get(id)!] : []),
    attackPaths: report.attackPathIds.flatMap((id) => pathsById.get(id) ? [pathsById.get(id)!] : []),
  };
}

const text = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2);

export function securityReportMarkdown(document: SecurityReportExport): string {
  const { report } = document;
  const lines = [
    `# ${report.title}`,
    "",
    `> Status: ${report.status} · Review: ${report.reviewStatus} · Version: ${report.version}`,
    "",
    "## Executive summary", "", report.executiveSummary,
  ];
  if (report.scope) lines.push("", "## Scope", "", report.scope);
  if (report.methodology) lines.push("", "## Methodology", "", report.methodology);
  lines.push("", "## Verified findings", "");
  for (const finding of document.findings) {
    lines.push(`### ${finding.title}`, "", finding.verificationSummary ?? "Verified without an additional summary.", "", "```json", text(finding.value), "```", "", `Evidence: ${(finding.evidenceRefs ?? []).join(", ")}`, "");
  }
  if (document.attackPaths.length) {
    lines.push("## Validated attack paths", "");
    for (const path of document.attackPaths) {
      lines.push(`### ${path.title}`, "", path.objective, "");
      for (const step of [...path.steps].sort((a, b) => a.order - b.order)) {
        lines.push(`${step.order + 1}. **${step.title}** — ${step.validation || step.description}`);
      }
      lines.push("");
    }
  }
  lines.push("## Limitations", "");
  if (report.limitations.length) for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  else lines.push("- No additional limitations were recorded.");
  if (report.reviewReasons.length) {
    lines.push("", "## Review required", "");
    for (const reason of report.reviewReasons) lines.push(`- ${reason}`);
  }
  lines.push(
    "", "## Provenance", "",
    `- Report ID: ${report.id}`,
    `- Source runs: ${report.sourceRunIds.join(", ")}`,
    `- Evidence refs: ${report.evidenceRefs.join(", ")}`,
    `- Exported at: ${document.exportedAt}`,
    "",
  );
  return lines.join("\n");
}
