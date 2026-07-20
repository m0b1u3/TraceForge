import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { ActionCardStore } from "./stores/action-store.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { SecurityReportStore } from "./stores/security-report-store.js";
import { TaskStore } from "./stores/task-store.js";
import { securityReportExport, securityReportMarkdown } from "./security-report-export.js";
import Fastify from "fastify";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { CaseStore } from "./stores/case-store.js";

function verifiedFinding(db: ReturnType<typeof createDb>, caseId: string) {
  const facts = new FactStore(db);
  const evidence = facts.create(caseId, {
    sourceRunId: "run_1", type: "http_observation", title: "Cross-identity response",
    value: { status: 200 }, source: { type: "traffic", ref: "traffic_1" },
    confidence: 1, tags: ["idor"],
  });
  const hypothesis = new HypothesisStore(db).create(caseId, {
    runId: "run_1", statement: "Ownership check is missing",
    basedOnFactIds: [evidence.id], status: "active",
  });
  const task = new TaskStore(db).create(caseId, {
    runId: "run_1", title: "Replay across identities", status: "done", reason: "completed",
    blockedBy: [], triggerWhen: [], relatedFacts: [evidence.id],
    hypothesisIds: [hypothesis.id], priority: "high",
  });
  const action = new ActionCardStore(db).create({
    id: `action_${caseId}`, caseId, title: "Replay request", goal: "Validate IDOR",
    evidenceRefs: [evidence.id], hypothesisRefs: [hypothesis.id], taskRefs: [task.id],
    reasoning: "Controlled identity comparison", steps: ["Replay"], expectedResults: ["Denied"],
    riskNotes: [], tool: "http_replay", priority: "high", requiresHumanApproval: false,
    status: "succeeded", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z",
  });
  const finding = facts.create(caseId, {
    sourceRunId: "run_1", type: "finding", title: "Order IDOR", value: { severity: "high" },
    source: { type: "agent", ref: "run_1" }, confidence: 1, tags: ["high"],
    findingStatus: "candidate", evidenceRefs: [evidence.id], hypothesisIds: [hypothesis.id],
    taskIds: [task.id], actionIds: [action.id], observations: [],
  });
  facts.update(finding.id, { findingStatus: "validating" });
  const verified = facts.update(finding.id, {
    findingStatus: "verified",
    verificationSummary: "Controlled replay reproduced unauthorized access.",
    observations: [{
      id: "obs_1", sourceType: "traffic", sourceRef: "traffic_1", runId: "run_1",
      condition: "authenticated cross-identity replay", summary: "Protected order returned",
      observedAt: "2026-07-20T00:01:00.000Z",
    }],
  });
  if (!verified) throw new Error("verified finding was not persisted");
  return { evidence, finding: verified };
}

describe("SecurityReportStore real SQLite lifecycle", () => {
  it("persists only evidence-backed verified findings with run provenance", () => {
    const db = createDb(":memory:");
    const { evidence, finding } = verifiedFinding(db, "case_1");
    const reports = new SecurityReportStore(db);
    const report = reports.create("case_1", {
      title: "Security assessment", status: "final",
      executiveSummary: "A verified authorization defect exposes another user's order.",
      scope: "Order API", methodology: "Controlled cross-identity replay",
      limitations: ["No destructive write operations were performed."],
      findingFactIds: [finding.id], attackPathIds: [], evidenceRefs: [evidence.id],
      sourceRunIds: ["run_1"],
    });
    expect(new SecurityReportStore(db).getById(report.id)).toEqual(report);
  });

  it("rejects cross-case evidence and provenance-free final reports", () => {
    const db = createDb(":memory:");
    const { evidence, finding } = verifiedFinding(db, "case_1");
    const foreign = verifiedFinding(db, "case_2");
    const reports = new SecurityReportStore(db);
    const base = {
      title: "Invalid report", status: "final" as const, executiveSummary: "Unsupported",
      scope: "", methodology: "", limitations: [], attackPathIds: [],
      findingFactIds: [finding.id], evidenceRefs: [evidence.id], sourceRunIds: ["run_1"],
    };
    expect(() => reports.create("case_1", { ...base, evidenceRefs: [foreign.evidence.id] })).toThrow(/missing or belong/);
    expect(() => reports.create("case_1", { ...base, evidenceRefs: [finding.id] })).toThrow(/omits Finding evidence/);
    expect(() => reports.create("case_1", { ...base, sourceRunIds: [] })).toThrow(/run provenance/);
  });

  it("marks reports for review when evidence changes and exports persisted content deterministically", () => {
    const db = createDb(":memory:");
    const { evidence, finding } = verifiedFinding(db, "case_1");
    const reports = new SecurityReportStore(db);
    const report = reports.create("case_1", {
      title: "Authorization review", status: "final", executiveSummary: "Verified IDOR.",
      scope: "Order API", methodology: "Controlled replay", limitations: ["Read-only validation."],
      findingFactIds: [finding.id], attackPathIds: [], evidenceRefs: [evidence.id], sourceRunIds: ["run_1"],
    });
    new FactStore(db).update(evidence.id, { title: "Cross-identity response re-evaluated" });
    const [stale] = reports.refreshAffected("case_1", evidence.id);
    expect(stale).toMatchObject({ reviewStatus: "needs_review", version: 2 });
    expect(stale.reviewReasons.join(" ")).toContain(evidence.id);

    const document = securityReportExport(db, report.id, "2026-07-20T03:00:00.000Z");
    expect(document).toMatchObject({ schemaVersion: 1, exportedAt: "2026-07-20T03:00:00.000Z" });
    const markdown = securityReportMarkdown(document!);
    expect(markdown).toContain("# Authorization review");
    expect(markdown).toContain("## Review required");
    expect(markdown).toContain("Read-only validation.");
  });

  it("serves Markdown and JSON exports from the real HTTP route", async () => {
    const db = createDb(":memory:");
    const caseId = new CaseStore(db).create("Export route", []).id;
    const { evidence, finding } = verifiedFinding(db, caseId);
    const report = new SecurityReportStore(db).create(caseId, {
      title: "Order API review", status: "final", executiveSummary: "Verified IDOR.",
      scope: "Order API", methodology: "Controlled replay", limitations: [],
      findingFactIds: [finding.id], attackPathIds: [], evidenceRefs: [evidence.id], sourceRunIds: ["run_1"],
    });
    const app = Fastify();
    const bus = new EventBus();
    registerRoutes(app, db, bus);
    await app.ready();
    const changedEvidence = new FactStore(db).update(evidence.id, { title: "Re-evaluated response" });
    if (!changedEvidence) throw new Error("evidence update failed");
    bus.emit({ type: "fact_updated", fact: changedEvidence });
    const reports = await app.inject({ url: `/api/cases/${caseId}/security-reports` });
    expect(reports.json()[0]).toMatchObject({ id: report.id, reviewStatus: "needs_review" });
    const markdown = await app.inject({ url: `/api/cases/${caseId}/security-reports/${report.id}/export?format=markdown` });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.headers["content-type"]).toContain("text/markdown");
    expect(markdown.headers["content-disposition"]).toContain(".md");
    expect(markdown.body).toContain("# Order API review");
    const json = await app.inject({ url: `/api/cases/${caseId}/security-reports/${report.id}/export?format=json` });
    expect(json.statusCode).toBe(200);
    expect(json.json()).toMatchObject({ schemaVersion: 1, report: { id: report.id } });
    await app.close();
  });
});
