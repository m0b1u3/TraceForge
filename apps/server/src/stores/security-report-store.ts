import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { SecurityReportSchema, type SecurityReport } from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { attackPaths, facts, securityReports } from "../db/schema.js";

export type SecurityReportInput = Omit<SecurityReport, "id" | "caseId" | "version" | "createdAt" | "updatedAt">;
export type SecurityReportPatch = Partial<Omit<SecurityReportInput, "sourceRunIds">> & { sourceRunIds?: string[] };

function hydrate(row: typeof securityReports.$inferSelect): SecurityReport {
  return SecurityReportSchema.parse({
    id: row.id,
    caseId: row.caseId,
    title: row.title,
    status: row.status,
    executiveSummary: row.executiveSummary,
    scope: row.scope,
    methodology: row.methodology,
    limitations: JSON.parse(row.limitationsJson),
    findingFactIds: JSON.parse(row.findingFactIdsJson),
    attackPathIds: JSON.parse(row.attackPathIdsJson),
    evidenceRefs: JSON.parse(row.evidenceRefsJson),
    sourceRunIds: JSON.parse(row.sourceRunIdsJson),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class SecurityReportStore {
  constructor(private db: Db) {}

  create(caseId: string, input: SecurityReportInput): SecurityReport {
    const now = new Date().toISOString();
    const report = SecurityReportSchema.parse({
      ...input,
      id: `report_${randomUUID()}`,
      caseId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.validate(report);
    this.db.insert(securityReports).values(this.values(report)).run();
    return report;
  }

  update(id: string, patch: SecurityReportPatch): SecurityReport | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const next = SecurityReportSchema.parse({
      ...current,
      ...patch,
      id: current.id,
      caseId: current.caseId,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.validate(next);
    this.db.update(securityReports).set(this.values(next)).where(eq(securityReports.id, id)).run();
    return next;
  }

  getById(id: string): SecurityReport | undefined {
    const row = this.db.select().from(securityReports).where(eq(securityReports.id, id)).get();
    return row ? hydrate(row) : undefined;
  }

  listByCase(caseId: string): SecurityReport[] {
    return this.db.select().from(securityReports).where(eq(securityReports.caseId, caseId))
      .orderBy(desc(securityReports.updatedAt)).all().map(hydrate);
  }

  private validate(report: SecurityReport): void {
    const factRows = this.db.select({
      id: facts.id,
      type: facts.type,
      status: facts.findingStatus,
      validity: facts.validity,
      evidenceRefsJson: facts.evidenceRefsJson,
    }).from(facts).where(eq(facts.caseId, report.caseId)).all();
    const factsById = new Map(factRows.map((fact) => [fact.id, fact]));
    const missingFacts = [...new Set([...report.findingFactIds, ...report.evidenceRefs])]
      .filter((id) => !factsById.has(id));
    if (missingFacts.length) throw new Error(`report Fact references are missing or belong to another case: ${missingFacts.join(", ")}`);
    if (report.findingFactIds.some((id) => {
      const fact = factsById.get(id);
      return fact?.type !== "finding" || fact.status !== "verified" || fact.validity !== "valid";
    })) throw new Error("reports may only include valid, verified Finding Facts");
    const reportEvidence = new Set(report.evidenceRefs);
    const omittedFindingEvidence = report.findingFactIds.flatMap((id) => {
      const fact = factsById.get(id);
      const required = fact ? JSON.parse(fact.evidenceRefsJson) as string[] : [];
      return required.filter((evidenceId) => !reportEvidence.has(evidenceId));
    });
    if (omittedFindingEvidence.length) {
      throw new Error(`report omits Finding evidence: ${[...new Set(omittedFindingEvidence)].join(", ")}`);
    }

    const pathRows = this.db.select({ id: attackPaths.id, status: attackPaths.status, evidenceRefsJson: attackPaths.evidenceRefsJson })
      .from(attackPaths).where(eq(attackPaths.caseId, report.caseId)).all();
    const pathsById = new Map(pathRows.map((path) => [path.id, path]));
    const missingPaths = report.attackPathIds.filter((id) => !pathsById.has(id));
    if (missingPaths.length) throw new Error(`report attack paths are missing or belong to another case: ${missingPaths.join(", ")}`);
    if (report.attackPathIds.some((id) => pathsById.get(id)?.status !== "validated")) {
      throw new Error("reports may only include validated attack paths");
    }
    const omittedPathEvidence = report.attackPathIds.flatMap((id) => {
      const path = pathsById.get(id);
      const required = path ? JSON.parse(path.evidenceRefsJson) as string[] : [];
      return required.filter((evidenceId) => !reportEvidence.has(evidenceId));
    });
    if (omittedPathEvidence.length) {
      throw new Error(`report omits attack-path evidence: ${[...new Set(omittedPathEvidence)].join(", ")}`);
    }
    if (report.status === "final" && report.sourceRunIds.length === 0) {
      throw new Error("final report requires run provenance");
    }
  }

  private values(report: SecurityReport): typeof securityReports.$inferInsert {
    return {
      id: report.id,
      caseId: report.caseId,
      title: report.title,
      status: report.status,
      executiveSummary: report.executiveSummary,
      scope: report.scope,
      methodology: report.methodology,
      limitationsJson: JSON.stringify(report.limitations),
      findingFactIdsJson: JSON.stringify(report.findingFactIds),
      attackPathIdsJson: JSON.stringify(report.attackPathIds),
      evidenceRefsJson: JSON.stringify(report.evidenceRefs),
      sourceRunIdsJson: JSON.stringify(report.sourceRunIds),
      version: report.version,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }
}
