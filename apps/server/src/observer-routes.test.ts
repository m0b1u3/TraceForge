import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import type { Db } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import type { RuntimeEvent } from "@traceforge/shared";
import { ObserverWarningStore } from "./stores/observer-store.js";
import { ObserverStrategyAuditStore } from "./stores/observer-strategy-audit-store.js";

let app: FastifyInstance;
let caseId: string;
let events: RuntimeEvent[];
let db: Db;

function buildApp() {
  app = Fastify();
  events = [];
  db = createDb(":memory:");
  const provider = realLlmProviderForTest();
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  registerRoutes(app, db, bus, provider);
}

beforeEach(async () => {
  buildApp();
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

function createOpenWarning() {
  return new ObserverWarningStore(db).create({
    id: "warn_test",
    caseId,
    level: "warning",
    issueType: "premature_completion",
    subject: "run:run_test",
    title: "过早结束",
    description: "还有点没测",
    relatedFacts: [],
    relatedTasks: [],
    suggestedAction: "继续测 X",
    status: "open",
    fingerprint: "warn-test-fingerprint",
    occurrenceCount: 1,
    lastObservedAt: new Date().toISOString(),
    correctionCount: 0,
    correctionResolvedCount: 0,
    correctionFailedCount: 0,
    correctionOutcome: "none",
    correctionEvidence: null,
    lastCorrectionAt: null,
    lastCorrectionTrigger: null,
    escalationReason: null,
    relatedRunId: "run_test",
    suggestedGoal: "[Observer correction]\n继续测 X",
    evidence: "trajectory: agent stopped before testing X",
    resolvedAt: null,
    createdAt: new Date().toISOString(),
  });
}

describe("observer integration", () => {
  it("GET /warnings returns stored warnings", async () => {
    createOpenWarning();
    const res = await app.inject({ url: `/api/cases/${caseId}/warnings` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatchObject({
      level: "warning",
      title: "过早结束",
      caseId,
      status: "open",
      suggestedGoal: "[Observer correction]\n继续测 X",
      evidence: "trajectory: agent stopped before testing X",
      resolvedAt: null,
    });
    expect(body.warnings[0].relatedRunId).toBe("run_test");
    expect(body.total).toBe(1);
  });

  it("GET /warnings is empty before any run", async () => {
    const res = await app.inject({ url: `/api/cases/${caseId}/warnings` });
    const body = res.json();
    expect(body.warnings).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns persisted recovery strategy decision audits", async () => {
    new ObserverStrategyAuditStore(db).create({
      id: "audit_route",
      caseId,
      runId: "run_audit",
      trigger: "interval",
      offeredCandidates: [{
        strategyId: "warn_strategy",
        relevanceScore: 124,
        relevanceReasons: ["fingerprint_match", "issue_type_match"],
        effectiveness: "active",
        usageCount: 1,
        successCount: 1,
        failureCount: 0,
      }],
      adoptions: [{ strategyId: "warn_strategy", warningIds: ["warn_result"] }],
      ignoredStrategyIds: [],
      contextCharacters: 312,
      createdAt: "2026-07-30T04:00:00.000Z",
    });

    const response = await app.inject({
      url: `/api/cases/${caseId}/observer/strategy-audits`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().audits).toEqual([expect.objectContaining({
      id: "audit_route",
      adoptions: [{ strategyId: "warn_strategy", warningIds: ["warn_result"] }],
    })]);
  });

  it("supports pagination and status filter", async () => {
    createOpenWarning();
    const store = new ObserverWarningStore(db);
    const dismissed = store.updateStatus("warn_test", "dismissed");
    expect(dismissed).toBeTruthy();
    const another: Parameters<typeof store.create>[0] = {
      id: "warn_other",
      caseId,
      level: "critical",
      issueType: "goal_drift",
      subject: "run:run_other",
      title: "偏离目标",
      description: "一直在测无关接口",
      relatedFacts: [],
      relatedTasks: [],
      suggestedAction: "回到登录流程",
      status: "open",
      fingerprint: "warn-other-fingerprint",
      occurrenceCount: 1,
      lastObservedAt: new Date().toISOString(),
      correctionCount: 0,
      correctionResolvedCount: 0,
      correctionFailedCount: 0,
      correctionOutcome: "none",
      correctionEvidence: null,
      lastCorrectionAt: null,
      lastCorrectionTrigger: null,
      escalationReason: null,
      relatedRunId: "run_other",
      suggestedGoal: "",
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    };
    store.create(another);

    const res = await app.inject({ url: `/api/cases/${caseId}/warnings?status=open&limit=1&offset=0` });
    const body = res.json();
    expect(body.warnings).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.warnings[0].status).toBe("open");
  });

  it("does not create duplicate open warnings for the same case", async () => {
    createOpenWarning();
    const store = new ObserverWarningStore(db);
    expect(store.existsOpenDuplicate(caseId, "过早结束", "还有点没测")).toBe(true);
    expect(store.existsOpenDuplicate(caseId, "过早结束", "不同描述")).toBe(false);
  });

  it("opens one correction window before escalating a repeated critical warning", () => {
    const store = new ObserverWarningStore(db);
    const first = store.create({
      ...createOpenWarning(),
      id: "warn_escalation",
      level: "critical",
      status: "detected",
      fingerprint: "stable-fingerprint",
      occurrenceCount: 1,
      lastObservedAt: new Date().toISOString(),
      escalationReason: null,
    });

    expect(first.status).toBe("detected");
    const correcting = store.observeAgain(first.id, {
      level: "critical",
      escalationReason: "Critical evidence remained unresolved across two Observer checkpoints.",
      suggestedAction: "Use an independent evidence source.",
      suggestedGoal: "Collect a causally independent result.",
      evidence: "The previous correction did not change the recorded evidence.",
    });

    expect(correcting).toMatchObject({
      status: "correcting",
      occurrenceCount: 2,
      escalationReason: "Critical evidence remained unresolved across two Observer checkpoints.",
      suggestedAction: "Use an independent evidence source.",
      suggestedGoal: "Collect a causally independent result.",
      evidence: "The previous correction did not change the recorded evidence.",
    });

    const escalated = store.observeAgain(first.id, {
      level: "critical",
      escalationReason: "Critical evidence remained unresolved after the Observer correction window.",
    });
    expect(escalated).toMatchObject({
      status: "escalated",
      occurrenceCount: 3,
      escalationReason: "Critical evidence remained unresolved after the Observer correction window.",
    });
    expect(store.observeAgain(first.id, { level: "critical" })).toEqual(escalated);
  });

  it("persists correction effectiveness across unresolved and resolved reviews", () => {
    const store = new ObserverWarningStore(db);
    const warning = store.create({
      ...createOpenWarning(),
      id: "warn_effectiveness",
      status: "detected",
    });

    const firstCorrection = store.recordCorrection(warning.id, "repeated_failure");
    expect(firstCorrection).toMatchObject({
      correctionCount: 1,
      correctionOutcome: "pending",
      lastCorrectionTrigger: "repeated_failure",
    });

    const persisted = store.settleCorrection(warning.id, "persisted");
    expect(persisted).toMatchObject({
      correctionResolvedCount: 0,
      correctionFailedCount: 1,
      correctionOutcome: "persisted",
    });

    store.recordCorrection(warning.id, "interval");
    const resolved = store.settleCorrection(warning.id, "resolved", "correction-linked evidence recorded");
    expect(resolved).toMatchObject({
      correctionCount: 2,
      correctionResolvedCount: 1,
      correctionFailedCount: 1,
      correctionOutcome: "resolved",
      correctionEvidence: "correction-linked evidence recorded",
    });

    store.recordCorrection(warning.id, "interval");
    const unattributed = store.settleCorrection(warning.id, "unattributed", "warning disappeared without linked evidence");
    expect(unattributed).toMatchObject({
      correctionCount: 3,
      correctionResolvedCount: 1,
      correctionFailedCount: 1,
      correctionOutcome: "unattributed",
      correctionEvidence: "warning disappeared without linked evidence",
    });
  });

  it("marks a correction stalled without double-counting it as another failure", () => {
    const store = new ObserverWarningStore(db);
    const warning = store.create({
      ...createOpenWarning(),
      id: "warn_stalled",
      status: "detected",
    });
    store.recordCorrection(warning.id, "interval");
    const persisted = store.settleCorrection(warning.id, "persisted", "warning reobserved");
    const stalled = store.markCorrectionStalled(warning.id, "no materially new strategy");

    expect(persisted?.correctionFailedCount).toBe(1);
    expect(stalled).toMatchObject({
      correctionOutcome: "stalled",
      correctionFailedCount: 1,
      correctionEvidence: "no materially new strategy",
    });
  });

  it("binds a human direction to the recovery run and reopens attribution", () => {
    const store = new ObserverWarningStore(db);
    const warning = store.create({
      ...createOpenWarning(),
      id: "warn_human_recovery",
      level: "critical",
      status: "escalated",
      correctionCount: 2,
      correctionFailedCount: 1,
      correctionOutcome: "stalled",
      correctionEvidence: "no materially new strategy",
      escalationReason: "human direction required",
    });

    const recovered = store.beginHumanRecovery(
      warning.id,
      "run_recovery",
      "Compare the candidate through an independent evidence source.",
    );

    expect(recovered).toMatchObject({
      status: "detected",
      relatedRunId: "run_recovery",
      suggestedGoal: "Compare the candidate through an independent evidence source.",
      correctionCount: 3,
      correctionFailedCount: 1,
      correctionOutcome: "pending",
      correctionEvidence: null,
      lastCorrectionTrigger: "human_direction",
      escalationReason: null,
      resolvedAt: null,
    });
    expect(recovered?.lastCorrectionAt).toEqual(expect.any(String));
  });

  it("does not reopen a warning that is not awaiting human direction", () => {
    const store = new ObserverWarningStore(db);
    const warning = createOpenWarning();

    expect(store.beginHumanRecovery(warning.id, "run_recovery", "Use a different strategy.")).toBeUndefined();
    expect(store.getById(warning.id)).toEqual(warning);
  });

  it("persists and accumulates only declared recovery strategy references", () => {
    const store = new ObserverWarningStore(db);
    const warning = store.create({
      ...createOpenWarning(),
      id: "warn_reused_strategy",
      recoveryStrategyRefs: ["warn_strategy_1"],
    });

    const observed = store.observeAgain(warning.id, {
      level: "warning",
      recoveryStrategyRefs: ["warn_strategy_1", "warn_strategy_2"],
    });

    expect(observed?.recoveryStrategyRefs).toEqual(["warn_strategy_1", "warn_strategy_2"]);
    expect(store.getById(warning.id)?.recoveryStrategyRefs).toEqual([
      "warn_strategy_1",
      "warn_strategy_2",
    ]);
  });

  it("isolates fingerprints by run and resolves warnings superseded by a new run", () => {
    const store = new ObserverWarningStore(db);
    const previous = createOpenWarning();

    expect(store.getActiveByFingerprint(caseId, "run_other", previous.fingerprint)).toBeUndefined();
    expect(store.getActiveByFingerprint(caseId, "run_test", previous.fingerprint)?.id).toBe(previous.id);

    const resolved = store.resolveActiveFromOtherRuns(caseId, "run_next");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      id: previous.id,
      status: "resolved",
      relatedRunId: "run_test",
    });
    expect(store.getById(previous.id)?.resolvedAt).toEqual(expect.any(String));
  });

  it("accepts an open warning and emits an update event", async () => {
    const warning = createOpenWarning();

    const res = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/accept` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: warning.id, status: "accepted" });
    expect(res.json().resolvedAt).toEqual(expect.any(String));
    expect(events).toContainEqual({ type: "observer_warning_updated", warning: res.json() });
  });

  it("dismisses an open warning and emits an update event", async () => {
    const warning = createOpenWarning();

    const res = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/dismiss` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: warning.id, status: "dismissed" });
    expect(events).toContainEqual({ type: "observer_warning_updated", warning: res.json() });
  });

  it("converts an open warning into a task and emits task/timeline/update events", async () => {
    const warning = createOpenWarning();

    const res = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/convert-task` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.warning).toMatchObject({ id: warning.id, status: "converted_to_task" });
    expect(body.task).toMatchObject({
      caseId,
      title: "过早结束",
      status: "open",
      relatedFacts: [],
      priority: "medium",
    });
    expect(body.task.reason).toContain("还有点没测");
    expect(body.task.reason).toContain("Observer suggestion: 继续测 X");
    expect(events).toContainEqual({ type: "task_created", task: body.task });
    expect(events).toContainEqual({ type: "observer_warning_updated", warning: body.warning });
    expect(events.some((event) => event.type === "timeline_appended" && event.entry.refId === body.task.id)).toBe(true);
  });
});
