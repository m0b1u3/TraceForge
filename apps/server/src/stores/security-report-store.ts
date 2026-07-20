import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import {
  SecurityReportRevisionSchema,
  SecurityReportSchema,
  type SecurityReport,
  type SecurityReportDiff,
  type SecurityReportRevision,
} from "@traceforge/shared";
import type { Db } from "../db/client.js";
import { attackPaths, facts, securityReportRevisions, securityReports } from "../db/schema.js";

type ManagedFields = "id" | "caseId" | "reviewStatus" | "reviewReasons" | "dependencyVersions" | "version" | "createdAt" | "updatedAt";
export type SecurityReportInput = Omit<SecurityReport, ManagedFields>;
export type SecurityReportPatch = Partial<SecurityReportInput>;

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
    reviewStatus: row.reviewStatus,
    reviewReasons: JSON.parse(row.reviewReasonsJson),
    dependencyVersions: JSON.parse(row.dependencyVersionsJson),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function hydrateRevision(row: typeof securityReportRevisions.$inferSelect): SecurityReportRevision {
  return SecurityReportRevisionSchema.parse({
    id: row.id,
    reportId: row.reportId,
    caseId: row.caseId,
    version: row.version,
    changeType: row.changeType,
    snapshot: JSON.parse(row.snapshotJson),
    diff: JSON.parse(row.diffJson),
    reviewDecision: row.reviewDecision,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  });
}

const difference = (next: string[], previous: string[]): string[] => next.filter((id) => !previous.includes(id));

function reportDiff(previous: SecurityReport | undefined, next: SecurityReport): SecurityReportDiff {
  if (!previous) return {
    changedFields: ["created"],
    addedFindingFactIds: next.findingFactIds,
    removedFindingFactIds: [],
    addedAttackPathIds: next.attackPathIds,
    removedAttackPathIds: [],
    addedEvidenceRefs: next.evidenceRefs,
    removedEvidenceRefs: [],
  };
  const fields: Array<keyof SecurityReport> = [
    "title", "status", "executiveSummary", "scope", "methodology", "limitations",
    "findingFactIds", "attackPathIds", "evidenceRefs", "sourceRunIds", "reviewStatus", "reviewReasons",
  ];
  return {
    changedFields: fields.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field])),
    addedFindingFactIds: difference(next.findingFactIds, previous.findingFactIds),
    removedFindingFactIds: difference(previous.findingFactIds, next.findingFactIds),
    addedAttackPathIds: difference(next.attackPathIds, previous.attackPathIds),
    removedAttackPathIds: difference(previous.attackPathIds, next.attackPathIds),
    addedEvidenceRefs: difference(next.evidenceRefs, previous.evidenceRefs),
    removedEvidenceRefs: difference(previous.evidenceRefs, next.evidenceRefs),
  };
}

export class SecurityReportStore {
  constructor(private db: Db) {}

  create(caseId: string, input: SecurityReportInput): SecurityReport {
    const now = new Date().toISOString();
    const report = SecurityReportSchema.parse({
      ...input,
      reviewStatus: "current",
      reviewReasons: [],
      dependencyVersions: this.dependencyVersions(caseId, input.findingFactIds, input.evidenceRefs, input.attackPathIds),
      id: `report_${randomUUID()}`,
      caseId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.validate(report);
    this.db.insert(securityReports).values(this.values(report)).run();
    this.recordRevision(undefined, report, "created");
    return report;
  }

  update(id: string, patch: SecurityReportPatch): SecurityReport | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const next = SecurityReportSchema.parse({
      ...current,
      ...patch,
      reviewStatus: "current",
      reviewReasons: [],
      dependencyVersions: this.dependencyVersions(
        current.caseId,
        patch.findingFactIds ?? current.findingFactIds,
        patch.evidenceRefs ?? current.evidenceRefs,
        patch.attackPathIds ?? current.attackPathIds,
      ),
      id: current.id,
      caseId: current.caseId,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.validate(next);
    this.db.update(securityReports).set(this.values(next)).where(eq(securityReports.id, id)).run();
    this.recordRevision(current, next, "content_updated");
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

  refreshAffected(caseId: string, dependencyId: string): SecurityReport[] {
    const affected = this.listByCase(caseId).filter((report) =>
      report.findingFactIds.includes(dependencyId)
      || report.evidenceRefs.includes(dependencyId)
      || report.attackPathIds.includes(dependencyId));
    return affected.flatMap((report) => {
      const reasons = this.reviewReasons(report);
      const reviewStatus = reasons.length ? "needs_review" as const : "current" as const;
      if (report.reviewStatus === reviewStatus && JSON.stringify(report.reviewReasons) === JSON.stringify(reasons)) return [];
      const updated = SecurityReportSchema.parse({
        ...report,
        reviewStatus,
        reviewReasons: reasons,
        version: report.version + 1,
        updatedAt: new Date().toISOString(),
      });
      this.db.update(securityReports).set(this.values(updated)).where(eq(securityReports.id, report.id)).run();
      this.recordRevision(report, updated, "dependency_changed");
      return [updated];
    });
  }

  listRevisions(reportId: string): SecurityReportRevision[] {
    return this.db.select().from(securityReportRevisions).where(eq(securityReportRevisions.reportId, reportId))
      .orderBy(asc(securityReportRevisions.version)).all().map(hydrateRevision);
  }

  acceptRevision(revisionId: string): SecurityReportRevision | undefined {
    const row = this.db.select().from(securityReportRevisions).where(eq(securityReportRevisions.id, revisionId)).get();
    if (!row) return undefined;
    const accepted = SecurityReportRevisionSchema.parse({
      ...hydrateRevision(row),
      reviewDecision: "accepted",
      reviewedAt: new Date().toISOString(),
    });
    this.db.update(securityReportRevisions).set({
      reviewDecision: accepted.reviewDecision,
      reviewedAt: accepted.reviewedAt,
    }).where(eq(securityReportRevisions.id, revisionId)).run();
    return accepted;
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
      reviewStatus: report.reviewStatus,
      reviewReasonsJson: JSON.stringify(report.reviewReasons),
      dependencyVersionsJson: JSON.stringify(report.dependencyVersions),
      version: report.version,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }

  private recordRevision(previous: SecurityReport | undefined, report: SecurityReport, changeType: SecurityReportRevision["changeType"]): void {
    const createdAt = new Date().toISOString();
    const revision = SecurityReportRevisionSchema.parse({
      id: `report_revision_${randomUUID()}`,
      reportId: report.id,
      caseId: report.caseId,
      version: report.version,
      changeType,
      snapshot: report,
      diff: reportDiff(previous, report),
      reviewDecision: "pending",
      reviewedAt: null,
      createdAt,
    });
    this.db.insert(securityReportRevisions).values({
      id: revision.id,
      reportId: revision.reportId,
      caseId: revision.caseId,
      version: revision.version,
      changeType: revision.changeType,
      snapshotJson: JSON.stringify(revision.snapshot),
      diffJson: JSON.stringify(revision.diff),
      reviewDecision: revision.reviewDecision,
      reviewedAt: revision.reviewedAt,
      createdAt: revision.createdAt,
    }).run();
  }

  private dependencyVersions(caseId: string, findingIds: string[], evidenceIds: string[], pathIds: string[]): Record<string, number> {
    const factIds = new Set([...findingIds, ...evidenceIds]);
    const factVersions = this.db.select({ id: facts.id, version: facts.updateCount }).from(facts)
      .where(eq(facts.caseId, caseId)).all()
      .filter((fact) => factIds.has(fact.id));
    const pathVersions = this.db.select({ id: attackPaths.id, version: attackPaths.version }).from(attackPaths)
      .where(eq(attackPaths.caseId, caseId)).all()
      .filter((path) => pathIds.includes(path.id));
    return Object.fromEntries([...factVersions, ...pathVersions].map((item) => [item.id, item.version]));
  }

  private reviewReasons(report: SecurityReport): string[] {
    const reasons: string[] = [];
    const factIds = new Set([...report.findingFactIds, ...report.evidenceRefs]);
    const factRows = this.db.select({
      id: facts.id, version: facts.updateCount, validity: facts.validity,
      type: facts.type, status: facts.findingStatus,
    }).from(facts).where(eq(facts.caseId, report.caseId)).all()
      .filter((fact) => factIds.has(fact.id));
    const factsById = new Map(factRows.map((fact) => [fact.id, fact]));
    for (const id of factIds) {
      const fact = factsById.get(id);
      if (!fact) reasons.push(`Referenced Fact ${id} is no longer available.`);
      else if (fact.version !== report.dependencyVersions[id]) reasons.push(`Fact ${id} changed after this report was generated.`);
      if (fact && fact.validity !== "valid") reasons.push(`Fact ${id} is ${fact.validity}.`);
    }
    for (const id of report.findingFactIds) {
      const finding = factsById.get(id);
      if (finding && (finding.type !== "finding" || finding.status !== "verified")) reasons.push(`Finding ${id} is no longer verified.`);
    }
    const paths = this.db.select({ id: attackPaths.id, version: attackPaths.version, status: attackPaths.status })
      .from(attackPaths).where(eq(attackPaths.caseId, report.caseId)).all()
      .filter((path) => report.attackPathIds.includes(path.id));
    const pathsById = new Map(paths.map((path) => [path.id, path]));
    for (const id of report.attackPathIds) {
      const path = pathsById.get(id);
      if (!path) reasons.push(`Attack path ${id} is no longer available.`);
      else {
        if (path.version !== report.dependencyVersions[id]) reasons.push(`Attack path ${id} changed after this report was generated.`);
        if (path.status !== "validated") reasons.push(`Attack path ${id} is no longer validated.`);
      }
    }
    return [...new Set(reasons)];
  }
}
