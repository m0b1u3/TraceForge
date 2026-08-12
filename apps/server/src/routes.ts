import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { cases, identityContexts, attackPaths, securityReportRevisions, securityReports, trafficEntries, artifacts, artifactAnalysisAttempts, artifactRetryAuthorizations, artifactRecoveries, artifactLimitationDispositions, facts, tasks, timeline, actionCards, decisions, agentEvents, observerWarnings, observerStrategyAudits, runCognitiveState, hypotheses, contextSummaries, knowledgeUsage, validationConclusions, validationConsensus } from "./db/schema.js";
import { CaseStore } from "./stores/case-store.js";
import { TrafficStore } from "./stores/traffic-store.js";
import { FactStore } from "./stores/fact-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { EventBus } from "./event-bus.js";
import { aggregateArtifactAnalysis, parseObserverCorrectionAudit, serializeObserverCorrectionAudit, validationTimelineConsoleEvent, type Task, type ObserverWarning, type CaseSummary, type Fact, type TimelineEntry, type AgentEventRefs, type ArtifactRecord } from "@traceforge/shared";
import type { LlmProvider } from "@traceforge/llm";
import { loadLlmConfig, createProviderFromConfig } from "@traceforge/llm";
import { ActionCardStore } from "./stores/action-store.js";
import { DecisionStore } from "./stores/decision-store.js";
import {
  ToolRegistry, ApprovalGate, AgentRuntime,
  makeListTrafficTool, makeGetTrafficTool,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeReopenTaskTool, makeRevertDoneTaskTool,
  makeHttpReplayTool, makeProposeScopeExpansionTool, makeBrowserTools, BROWSER_TOOL_NAMES,
  makeReplayTrafficTool, makeExtractApiEndpointsTool,
  makeCompareIdentityTrafficTool, makeListIdentitiesTool, makeRecordIdentityTool, makeUseBrowserIdentityTool,
  makeAssessValidationExperimentTool,
  makeListAttackPathsTool, makeRecordAttackPathTool,
  makeListSecurityReportsTool, makeRecordSecurityReportTool,
  McpManager, mcpToolToDescriptor, Observer, LlmQueryExpander,
  makeReevaluateFactsTool, FailureMemory, makeDownloadTool,
  type AgentRunBudget, type ObserverReviewTrigger, type ToolDescriptor,
} from "@traceforge/extension";
import { BrowserSession } from "./browser-session.js";
import { ObserverWarningStore } from "./stores/observer-store.js";
import { AgentEventStore } from "./stores/agent-event-store.js";
import { collectToolRefs } from "./agent-event-refs.js";
import { ApprovalRegistry } from "./agent-approvals.js";
import { AgentRunRegistry, isContinuationGoal } from "./agent-runs.js";
import { SessionStateStore } from "./stores/session-state-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { ContextSummaryStore } from "./stores/context-summary-store.js";
import { buildContext, compressFar, deriveContextBudget, estimateTokens, shouldCompressFarHistory } from "@traceforge/reasoning-core";
import { makeUpdateSessionStateTool, makeRecordHypothesisTool, makeResolveHypothesisTool, makeSearchFactsTool, makeGetFactDetailTool, makeSearchTrafficTool, makeRecallConversationTool, makeRecallCaseKnowledgeTool } from "@traceforge/extension";
import { LlmConfigService, type LlmConfigDto } from "./llm-config-service.js";
import { calculateUsageCost } from "./llm-cost.js";
import { PendingInterventionRegistry } from "./pending-interventions.js";
import { AgentRunStore } from "./stores/agent-run-store.js";
import {
  initialObserverStatus,
  observerCorrectionStallDecision,
  observerFingerprint,
  observerHumanRecoveryWindowIsOpen,
  observerIntervention,
  validatedObserverLevel,
} from "./observer-policy.js";
import { HypothesisScheduler } from "./hypothesis-scheduler.js";
import { HypothesisFeedbackCoordinator } from "./hypothesis-feedback.js";
import { IdentityStore } from "./stores/identity-store.js";
import { AttackPathStore } from "./stores/attack-path-store.js";
import { SecurityReportStore } from "./stores/security-report-store.js";
import { securityReportExport, securityReportMarkdown } from "./security-report-export.js";
import { ObserverScheduler } from "./observer-scheduler.js";
import { ObserverCadence, observerCadenceSnapshot } from "./observer-cadence.js";
import { ObserverCorrectionAttribution } from "./observer-correction-attribution.js";
import {
  selectVerifiedObserverRecoveryStrategies,
} from "./observer-recovery-strategies.js";
import { buildObserverStrategyAudit } from "./observer-strategy-audit.js";
import { ObserverStrategyAuditStore } from "./stores/observer-strategy-audit-store.js";
import { buildSharedKnowledge } from "./shared-knowledge.js";
import { KnowledgeUsageStore, type KnowledgeRef } from "./stores/knowledge-usage-store.js";
import { KnowledgeOutcomeTracker } from "./knowledge-outcome.js";
import { buildExplorationAdvisory } from "./exploration-advisor.js";
import { formatAttackPathPlan, rankAttackPathBreakpoints } from "./attack-path-planner.js";
import { formatEvidenceGapPlan, mapEvidenceGaps } from "./evidence-gap-planner.js";
import { buildValidationMatrices, formatValidationMatrices } from "./validation-matrix.js";
import { ValidationConclusionStore } from "./stores/validation-conclusion-store.js";
import { makeRecordValidationConclusionTool } from "./validation-conclusion-tool.js";
import { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import { evaluateValidationTaskCompletion } from "./validation-task-gate.js";
import { resumePendingValidations } from "./validation-resume.js";
import { formatValidationTaskPriorities, rankValidationTasks } from "./validation-task-priority.js";
import { decideValidationPriorityShift, validationPriorityLeader } from "./validation-priority-hysteresis.js";
import { advanceExplorationBoundary, applyValidationExplorationPolicy, initialValidationExplorationState } from "./validation-exploration-policy.js";
import { appendValidationFeedback, observeValidationOutcome, recoverValidationFeedback, summarizeValidationFeedbackHistory, type ValidationOutcomeSnapshot } from "./validation-task-feedback.js";
import { evaluateRecordTaskValidationStatusTransition, isConsensusValidationTask, validationFindingId } from "./validation-task-execution.js";
import { releaseValidationTaskLeases } from "./validation-task-lease.js";
import { makeManageValidationTaskTool } from "./validation-task-control-tool.js";
import { auditValidationWorkflow } from "./validation-workflow-audit.js";
import { buildValidationWorkflowSnapshot, makeGetValidationWorkflowStateTool, type ValidationRuntimeSnapshot } from "./validation-workflow-snapshot.js";
import {
  InvestigationStructurePolicy,
} from "./investigation-runtime-policy.js";
import { reconcileUnsupportedEndpointFacts } from "./endpoint-fact-reconciliation.js";
import { ArtifactStore } from "./stores/artifact-store.js";
import { ArtifactAnalysisAttemptStore } from "./stores/artifact-analysis-attempt-store.js";
import { ArtifactRetryAuthorizationStore } from "./stores/artifact-retry-authorization-store.js";
import { ArtifactRecoveryStore } from "./stores/artifact-recovery-store.js";
import { ArtifactLimitationStore } from "./stores/artifact-limitation-store.js";
import { ArtifactAnalyzerRegistry, JhatHprofAnalyzer } from "./artifact-analyzer.js";
import { makeAnalyzeArtifactTool, makeListArtifactsTool, makePlanArtifactAnalysisTool, registerExistingCaseArtifacts } from "./artifact-tools.js";
import { connectArtifactEvidenceLifecycle } from "./artifact-evidence-lifecycle.js";
import { artifactEvidenceForConsumption, EvidenceConsumptionTracker } from "./evidence-consumption-tracker.js";
import { projectArtifactConsumptions } from "./artifact-consumption-projection.js";
import { combineTaskCompletionGates, evaluateArtifactTaskReadiness } from "./artifact-task-readiness.js";
import { makeManageArtifactLimitationTool } from "./artifact-limitation-tool.js";
import { planArtifactAnalysis } from "./artifact-analysis-planner.js";
import { makeAuthorizeArtifactRetryTool } from "./artifact-retry-authorization-tool.js";
import { makeManageArtifactRecoveryTool } from "./artifact-recovery-tool.js";

function historyPageOptions(query: unknown): { limit?: number; offset?: number } {
  const value = (query ?? {}) as { limit?: string | number; offset?: string | number };
  if (value.limit === undefined) return {};
  const parsedLimit = Number(value.limit);
  const parsedOffset = Number(value.offset ?? 0);
  return {
    limit: Number.isFinite(parsedLimit) ? Math.min(10_000, Math.max(1, Math.trunc(parsedLimit))) : 1_000,
    offset: Number.isFinite(parsedOffset) ? Math.max(0, Math.trunc(parsedOffset)) : 0,
  };
}

export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  bus: EventBus,
  provider?: LlmProvider,
  mcp?: McpManager,
  llmService?: LlmConfigService,
  projectRoot = process.cwd(),
): void {
  const cases = new CaseStore(db);
  const traffic = new TrafficStore(db);
  const artifactStore = new ArtifactStore(db);
  const artifactAttemptStore = new ArtifactAnalysisAttemptStore(db);
  const artifactRetryAuthorizationStore = new ArtifactRetryAuthorizationStore(db);
  const artifactRecoveryStore = new ArtifactRecoveryStore(db);
  const artifactLimitationStore = new ArtifactLimitationStore(db);
  artifactAttemptStore.recoverInterrupted();
  const artifactAnalyzers = new ArtifactAnalyzerRegistry();
  artifactAnalyzers.register(new JhatHprofAnalyzer());
  const factStore = new FactStore(db);
  const taskStore = new TaskStore(db);
  const timelineStore = new TimelineStore(db);
  const artifactConsumptionSnapshot = (caseId: string) =>
    projectArtifactConsumptions(caseId, timelineStore.listByCase(caseId));
  const emitArtifactConsumptionSnapshot = (caseId: string) => {
    const consumptions = artifactConsumptionSnapshot(caseId);
    bus.emit({ type: "artifact_consumption_snapshot", caseId, consumptions });
    return consumptions;
  };
  const syncArtifactEvidenceFacts = (artifact: ArtifactRecord): Fact[] => {
    if (!["analyzed", "unsupported", "failed"].includes(artifact.status)) return [];
    const existingFacts = factStore.listByCase(artifact.caseId);
    const existingTags = new Set(existingFacts.flatMap((fact) => fact.tags));
    const created: Fact[] = [];
    const recordFact = (
      key: string,
      input: Parameters<FactStore["create"]>[1],
      duplicate?: (fact: Fact) => boolean,
    ) => {
      const tag = `artifact-evidence:${artifact.id}:${key}`;
      if (existingTags.has(tag) || (duplicate && existingFacts.some(duplicate))) return;
      const fact = factStore.create(artifact.caseId, { ...input, tags: [...input.tags, tag] });
      existingTags.add(tag);
      created.push(fact);
      const entry = timelineStore.append(artifact.caseId, "fact_created", `Artifact evidence: ${fact.title}`, fact.id, artifact.runId ?? undefined);
      bus.emit({ type: "fact_created", fact });
      bus.emit({ type: "timeline_appended", entry });
    };
    if (!artifact.analysis) {
      recordFact(`analysis-${artifact.status}:${artifact.analyzerId ?? "unresolved"}`, {
        sourceRunId: artifact.runId,
        type: "artifact_analysis",
        title: `Artifact analysis ${artifact.status}: ${artifact.filename}`,
        value: {
          artifactId: artifact.id,
          path: artifact.relativePath,
          sha256: artifact.sha256,
          format: artifact.detectedFormat,
          byteSize: artifact.byteSize,
          status: artifact.status,
          analyzerId: artifact.analyzerId,
          error: artifact.error,
        },
        source: { type: "artifact_analysis", ref: artifact.id },
        confidence: 1,
        tags: ["artifact", "analysis", "coverage-gap", artifact.detectedFormat],
        verificationSummary: artifact.error ?? `Artifact analysis status is ${artifact.status}.`,
        observations: [{
          id: `observation_${artifact.id}_${artifact.status}`,
          sourceType: "artifact_analysis",
          sourceRef: artifact.id,
          runId: artifact.runId,
          condition: `status=${artifact.status}`,
          summary: artifact.error ?? `Artifact analysis status is ${artifact.status}.`,
          observedAt: artifact.updatedAt,
        }],
      }, (fact) => {
        const value = fact.value as { artifactId?: string; status?: string; analyzerId?: string };
        return fact.type === "artifact_analysis"
          && value.artifactId === artifact.id
          && value.status === artifact.status
          && (value.analyzerId ?? artifact.analyzerId) === artifact.analyzerId;
      });
      return created;
    }
    recordFact(`analysis:${artifact.analysis.analyzerId}`, {
      sourceRunId: artifact.runId,
      type: "artifact_analysis",
      title: `Analyzed artifact: ${artifact.filename}`,
      value: {
        artifactId: artifact.id,
        path: artifact.relativePath,
        sha256: artifact.sha256,
        format: artifact.detectedFormat,
        byteSize: artifact.byteSize,
        analyzerId: artifact.analysis.analyzerId,
        summary: artifact.analysis.summary,
        coverage: artifact.analysis.coverage,
      },
      source: { type: "artifact_analysis", ref: artifact.id },
      confidence: artifact.analysis.coverage.objectGraph ? 0.95 : 0.75,
      tags: ["artifact", "analysis", artifact.detectedFormat],
      verificationSummary: artifact.analysis.summary,
      observations: [{
        id: `observation_${artifact.id}_analysis`,
        sourceType: "artifact_analysis",
        sourceRef: artifact.id,
        runId: artifact.runId,
        condition: `analyzer=${artifact.analysis.analyzerId}`,
        summary: artifact.analysis.summary,
        observedAt: artifact.updatedAt,
      }],
    }, (fact) => {
      const value = fact.value as { artifactId?: string; analyzerId?: string };
      return fact.type === "artifact_analysis"
        && value.artifactId === artifact.id
        && value.analyzerId === artifact.analysis?.analyzerId;
    });
    artifact.analysis.findings.forEach((finding, index) => recordFact(`finding:${artifact.analysis?.analyzerId}:${index}`, {
      sourceRunId: artifact.runId,
      type: "artifact_evidence",
      title: `${finding.label} recovered from ${artifact.filename}`,
      value: {
        artifactId: artifact.id,
        analyzerId: artifact.analysis?.analyzerId,
        kind: finding.kind,
        label: finding.label,
        value: finding.value,
        sensitive: finding.sensitive ?? false,
        evidence: finding.evidence,
        coverage: artifact.analysis?.coverage,
      },
      source: { type: "artifact_analysis", ref: artifact.id },
      confidence: finding.confidence,
      tags: ["artifact", "evidence", finding.kind, artifact.detectedFormat],
      verificationSummary: `Recovered by ${artifact.analysis?.analyzerId} with traceable artifact relationship evidence.`,
      observations: [{
        id: `observation_${artifact.id}_${index}`,
        sourceType: "artifact_analysis",
        sourceRef: artifact.id,
        runId: artifact.runId,
        condition: finding.evidence.map((item) => item.relationship ?? item.path ?? item.objectId).filter(Boolean).join(" | "),
        summary: `${finding.label}=${finding.value}`,
        observedAt: artifact.updatedAt,
      }],
    }, (fact) => {
      const value = fact.value as { artifactId?: string; kind?: string; label?: string; value?: unknown };
      return fact.type === "artifact_evidence"
        && value.artifactId === artifact.id
        && value.kind === finding.kind
        && value.label === finding.label
        && value.value === finding.value;
    }));
    return created;
  };
  for (const currentCase of cases.list()) {
    for (const artifact of artifactStore.listByCase(currentCase.id)) syncArtifactEvidenceFacts(artifact);
  }
  const reconcileEndpointFacts = (caseId: string): void => {
    const reconciliation = reconcileUnsupportedEndpointFacts(caseId, factStore, timelineStore);
    for (const fact of reconciliation.facts) bus.emit({ type: "fact_updated", fact });
    for (const entry of reconciliation.timelineEntries) bus.emit({ type: "timeline_appended", entry });
  };
  for (const item of cases.list()) reconcileEndpointFacts(item.id);

  // model/baseUrl/provider 全部来自 config/llm.json；无配置或无 key 直接失败，禁止静默空跑。
  const llm: LlmProvider = provider ?? createProviderFromConfig(loadLlmConfig());
  const queryExpander = new LlmQueryExpander(llm);

  if (llmService) {
    app.get("/api/config/llm", async () => llmService.load());

    app.post("/api/config/llm/reveal-key", async (_req, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
      return { apiKey: llmService.revealApiKey() };
    });

    app.post("/api/config/llm", async (req, reply) => {
      const body = req.body as LlmConfigDto;
      if (!body.provider || !body.model) {
        return reply.code(400).send({ error: "provider and model are required" });
      }
      try {
        return llmService.reload(body);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    });

    app.post("/api/config/llm/test", async (req, reply) => {
      const body = req.body as LlmConfigDto;
      if (!body.provider || !body.model) {
        return reply.code(400).send({ error: "provider and model are required" });
      }
      return llmService.test(body);
    });
  }

  const actionStore = new ActionCardStore(db);
  const decisionStore = new DecisionStore(db);
  const observerStore = new ObserverWarningStore(db);
  const observerStrategyAuditStore = new ObserverStrategyAuditStore(db);
  const agentEventStore = new AgentEventStore(db);
  bus.subscribe((event) => {
    if (event.type !== "timeline_appended") return;
    if (!validationTimelineConsoleEvent(event.entry)) return;
    agentEventStore.append(event.entry.caseId, "validation", event.entry.detail, event.entry.eventType, event.entry.createdAt);
  });
  const sessionStore = new SessionStateStore(db);
  const hypothesisStore = new HypothesisStore(db, (event) => bus.emit(event));
  const hypothesisScheduler = new HypothesisScheduler(hypothesisStore, { tasks: taskStore });
  const identityStore = new IdentityStore(db);
  const attackPathStore = new AttackPathStore(db);
  const securityReportStore = new SecurityReportStore(db);
  const knowledgeUsageStore = new KnowledgeUsageStore(db);
  const validationConclusionStore = new ValidationConclusionStore(db);
  const validationConsensusStore = new ValidationConsensusStore(db);
  const hypothesisFeedback = new HypothesisFeedbackCoordinator(hypothesisStore, factStore, taskStore, attackPathStore, validationConsensusStore);
  bus.subscribe((event) => {
    const caseId = event.type === "fact_created" || event.type === "fact_updated"
      ? event.fact.caseId
      : event.type === "task_created" || event.type === "task_updated"
        ? event.task.caseId
        : event.type === "attack_path_created" || event.type === "attack_path_updated"
          ? event.attackPath.caseId
          : event.type === "timeline_appended" && event.entry.eventType === "validation_feedback_recorded"
            ? event.entry.caseId
            : null;
    if (!caseId) return;
    const feedback = summarizeValidationFeedbackHistory(recoverValidationFeedback(timelineStore.listByCase(caseId)));
    const runIds = new Set(hypothesisStore.listByCase(caseId)
      .filter((item) => item.runId && (item.status === "candidate" || item.status === "active"))
      .map((item) => item.runId as string));
    for (const affectedRunId of runIds) {
      hypothesisFeedback.reconcile(caseId, affectedRunId, feedback);
      const rebalanced = hypothesisScheduler.rebalance(caseId, affectedRunId);
      sessionStore.upsert(caseId, { activeHypothesisIds: rebalanced.active.map((item) => item.id) }, affectedRunId);
    }
  });
  bus.subscribe((event) => {
    const dependency = event.type === "fact_updated"
      ? { caseId: event.fact.caseId, id: event.fact.id }
      : event.type === "attack_path_updated"
        ? { caseId: event.attackPath.caseId, id: event.attackPath.id }
        : null;
    if (!dependency) return;
    for (const report of securityReportStore.refreshAffected(dependency.caseId, dependency.id)) {
      bus.emit({ type: "security_report_updated", report });
    }
  });
  const contextSummaryStore = new ContextSummaryStore(db);
  const approvals = new ApprovalRegistry();
  const pendingInterventions = new PendingInterventionRegistry();
  const runs = new AgentRunRegistry(new AgentRunStore(db));
  const validationRuntimeByRun = new Map<string, ValidationRuntimeSnapshot>();
  const validationRevisionByCase = new Map<string, number>();
  const currentValidationRevision = (caseId: string) => {
    const existing = validationRevisionByCase.get(caseId);
    if (existing !== undefined) return existing;
    const initial = Date.now() * 1000;
    validationRevisionByCase.set(caseId, initial);
    return initial;
  };
  const emitValidationWorkflow = (caseId: string, requestedRunId?: string) => {
    const runId = requestedRunId || runs.getActiveByCase(caseId)?.run.id || runs.getLatestByCase(caseId)?.run.id;
    const revision = Math.max(currentValidationRevision(caseId) + 1, Date.now() * 1000);
    validationRevisionByCase.set(caseId, revision);
    const snapshot = buildValidationWorkflowSnapshot({
      caseId,
      runId,
      revision,
      facts: factStore,
      hypotheses: hypothesisStore,
      tasks: taskStore,
      consensus: validationConsensusStore,
      artifacts: artifactStore,
      artifactAttempts: artifactAttemptStore,
      artifactLimitations: artifactLimitationStore,
      artifactAnalyzers,
      paths: attackPathStore,
      timeline: timelineStore,
      runtime: runId ? validationRuntimeByRun.get(runId) : undefined,
    });
    bus.emit({ type: "validation_workflow_updated", snapshot });
    return snapshot;
  };
  const emitReleasedValidationLeases = (caseId: string, runId: string, reason: string) => {
    const released = releaseValidationTaskLeases({ caseId, runId, reason, tasks: taskStore, timeline: timelineStore });
    for (const task of released.tasks) bus.emit({ type: "task_updated", task });
    for (const entry of released.timelineEntries) bus.emit({ type: "timeline_appended", entry });
    return released;
  };
  const emitValidationWorkflowAudit = (caseId: string) => {
    const audited = auditValidationWorkflow({
      caseId,
      facts: factStore,
      hypotheses: hypothesisStore,
      tasks: taskStore,
      consensus: validationConsensusStore,
      timeline: timelineStore,
    });
    for (const task of audited.tasks) bus.emit({ type: "task_updated", task });
    for (const entry of audited.timelineEntries) bus.emit({ type: "timeline_appended", entry });
    return audited;
  };
  for (const entry of cases.list()) {
    const staleRunIds = new Set(taskStore.listByCase(entry.id)
      .filter((task) => task.status === "running" && isConsensusValidationTask(task) && task.runId)
      .map((task) => task.runId as string));
    for (const runId of staleRunIds) emitReleasedValidationLeases(entry.id, runId, "server startup recovered an orphaned validation lease");
    emitValidationWorkflowAudit(entry.id);
  }

  app.post("/api/cases", async (req) => {
    const body = req.body as { name: string; allowHosts: string[]; denyHosts?: string[] };
    const c = cases.create(body.name, [
      { caseId: "", allowHosts: body.allowHosts, denyHosts: body.denyHosts ?? [] },
    ]);
    bus.emit({ type: "case_created", case: c });
    return c;
  });

  app.get("/api/cases", async () => cases.list());

  app.get("/api/cases/summary", async (): Promise<CaseSummary[]> => cases.list().map((entry) => {
    const caseTraffic = traffic.listByCase(entry.id);
    const caseFacts = factStore.listByCase(entry.id);
    const caseFindings = caseFacts.filter(isSecurityFinding);
    const caseTasks = taskStore.listByCase(entry.id);
    const caseTimeline = timelineStore.listByCase(entry.id);
    const caseEvents = agentEventStore.listByCase(entry.id);
    const latestRun = runs.getLatestByCase(entry.id)?.run;
    const intervention = pendingInterventions.get(entry.id);
    const severityCounts: CaseSummary["severityCounts"] = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const fact of caseFindings) severityCounts[factSeverity(fact)] += 1;
    const activity = [
      entry.createdAt,
      ...caseTraffic.map((item) => item.createdAt),
      ...caseFacts.map((item) => item.updatedAt || item.createdAt),
      ...caseTasks.map((item) => item.updatedAt || item.createdAt),
      ...caseTimeline.map((item) => item.createdAt),
      ...caseEvents.map((item) => item.createdAt),
      latestRun?.finishedAt ?? latestRun?.startedAt ?? latestRun?.createdAt ?? "",
    ].filter(Boolean).sort();
    const hasPending = Boolean(intervention.approval || intervention.scope);
    const runStatus: CaseSummary["runStatus"] = hasPending
      ? "waiting"
      : latestRun?.status === "running" || latestRun?.status === "interrupting"
        ? "running"
        : latestRun?.status === "failed"
          ? "failed"
          : latestRun?.status === "completed"
            ? "completed"
            : "idle";
    return {
      id: entry.id,
      name: entry.name,
      status: entry.status,
      target: entry.scopeRules.flatMap((rule) => rule.allowHosts)[0] ?? null,
      runStatus,
      trafficCount: caseTraffic.length,
      findingCount: caseFindings.length,
      severityCounts,
      pendingApproval: hasPending,
      lastActivityAt: activity.at(-1) ?? entry.createdAt,
      createdAt: entry.createdAt,
    };
  }));

  app.patch("/api/cases/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; status?: "active" | "paused" | "archived" };
    if (body.name !== undefined && !body.name.trim()) return reply.code(400).send({ error: "case name is required" });
    if (body.status !== undefined && !["active", "paused", "archived"].includes(body.status)) return reply.code(400).send({ error: "invalid case status" });
    const updated = cases.update(id, { ...(body.name !== undefined ? { name: body.name.trim() } : {}), ...(body.status !== undefined ? { status: body.status } : {}) });
    if (!updated) return reply.code(404).send({ error: "case not found" });
    return updated;
  });

  app.delete("/api/cases/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    pendingInterventions.clearCase(id);

    // Stop any active agent run for this case
    const active = runs.getActiveByCase(id);
    if (active) runs.interrupt(active.run.id, "case deleted");
    runs.clearCase(id);

    // Stop browser session if running
    const browserSession = browserSessions.get(id);
    if (browserSession) {
      try { await browserSession.stop(); } catch { /* ignore */ }
      browserSessions.delete(id);
    }

    // Delete filesystem workspace
    try { await rm(resolve(projectRoot, "data/cases", id), { recursive: true, force: true }); } catch { /* ignore missing dirs */ }

    // Cascade delete all case-associated data
    db.delete(trafficEntries).where(eq(trafficEntries.caseId, id)).run();
    db.delete(artifacts).where(eq(artifacts.caseId, id)).run();
    db.delete(artifactAnalysisAttempts).where(eq(artifactAnalysisAttempts.caseId, id)).run();
    db.delete(artifactRetryAuthorizations).where(eq(artifactRetryAuthorizations.caseId, id)).run();
    db.delete(artifactRecoveries).where(eq(artifactRecoveries.caseId, id)).run();
    db.delete(artifactLimitationDispositions).where(eq(artifactLimitationDispositions.caseId, id)).run();
    db.delete(identityContexts).where(eq(identityContexts.caseId, id)).run();
    db.delete(attackPaths).where(eq(attackPaths.caseId, id)).run();
    db.delete(securityReports).where(eq(securityReports.caseId, id)).run();
    db.delete(securityReportRevisions).where(eq(securityReportRevisions.caseId, id)).run();
    db.delete(facts).where(eq(facts.caseId, id)).run();
    db.delete(tasks).where(eq(tasks.caseId, id)).run();
    db.delete(timeline).where(eq(timeline.caseId, id)).run();
    db.delete(actionCards).where(eq(actionCards.caseId, id)).run();
    db.delete(decisions).where(eq(decisions.caseId, id)).run();
    db.delete(knowledgeUsage).where(eq(knowledgeUsage.caseId, id)).run();
    db.delete(validationConclusions).where(eq(validationConclusions.caseId, id)).run();
    db.delete(validationConsensus).where(eq(validationConsensus.caseId, id)).run();
    db.delete(agentEvents).where(eq(agentEvents.caseId, id)).run();
    db.delete(observerWarnings).where(eq(observerWarnings.caseId, id)).run();
    db.delete(observerStrategyAudits).where(eq(observerStrategyAudits.caseId, id)).run();
    db.delete(runCognitiveState).where(eq(runCognitiveState.caseId, id)).run();
    db.delete(hypotheses).where(eq(hypotheses.caseId, id)).run();
    db.delete(contextSummaries).where(eq(contextSummaries.caseId, id)).run();

    const deleted = cases.delete(id);
    bus.emit({ type: "case_deleted", caseId: id });
    return { deleted };
  });

  app.get("/api/cases/:id/traffic", async (req) => {
    const { id } = req.params as { id: string };
    return traffic.listByCase(id, historyPageOptions(req.query));
  });

  app.delete("/api/cases/:id/traffic", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    const deleted = traffic.clearByCase(id);
    bus.emit({ type: "traffic_cleared", caseId: id });
    return { ok: true, deleted };
  });

  // 人机共享浏览器会话（每 Case 一个），内存管理
  const browserSessions = new Map<string, BrowserSession>();
  const activeToolRegistries = new Map<string, {
    runId: string;
    registry: ToolRegistry;
    browserAttached: boolean;
    displaced: Map<string, ToolDescriptor>;
  }>();

  const detachBrowserTools = (caseId: string): void => {
    const active = activeToolRegistries.get(caseId);
    if (!active) return;
    if (!active.browserAttached) return;
    for (const name of BROWSER_TOOL_NAMES) active.registry.unregister(name);
    active.registry.unregister("use_browser_identity");
    for (const tool of active.displaced.values()) active.registry.register(tool);
    active.displaced.clear();
    active.browserAttached = false;
  };

  const attachBrowserTools = (caseId: string, session: BrowserSession): void => {
    const active = activeToolRegistries.get(caseId);
    if (!active) return;
    detachBrowserTools(caseId);
    const browserTools = [...makeBrowserTools(session), makeUseBrowserIdentityTool(caseId, identityStore, session)];
    for (const tool of browserTools) {
      const existing = active.registry.get(tool.name);
      if (existing) {
        active.displaced.set(tool.name, existing);
        active.registry.unregister(tool.name);
      }
      active.registry.register(tool);
    }
    active.browserAttached = true;
    runs.addRuntimeMessage(active.runId, "The shared browser is available. Use observe_page before interacting; browser actions and redirects remain scope-guarded.");
  };

  app.get("/api/cases/:id/browser", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    const session = browserSessions.get(id);
    if (!session) return { ok: true, controller: null, url: "", identity: null };
    return { ok: true, controller: session.controller(), url: session.currentUrl(), identity: session.currentIdentity() };
  });

  app.post("/api/cases/:id/browser/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });
    let session = browserSessions.get(id);
    if (!session) {
      // 传 getter：对话中批准纳入新 host 后，正在运行的浏览器立即按最新范围放行流量
      session = new BrowserSession(
        id,
        () => cases.get(id)?.scopeRules ?? [],
        traffic,
        bus,
        { headless: false },
        () => {
          if (browserSessions.get(id) === session) browserSessions.delete(id);
          detachBrowserTools(id);
        },
        () => runs.getActiveByCase(id)?.run.id ?? null,
      );
      browserSessions.set(id, session);
    }
    try {
      await session.start();
      attachBrowserTools(id, session);
    } catch (err) {
      browserSessions.delete(id);
      return reply.code(500).send({ error: "browser launch failed", reason: (err as Error).message });
    }
    return { ok: true, controller: session.controller(), url: session.currentUrl() };
  });

  app.post("/api/cases/:id/browser/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = browserSessions.get(id);
    if (!session) return reply.code(404).send({ error: "no browser session" });
    await session.stop();
    browserSessions.delete(id);
    detachBrowserTools(id);
    return { ok: true };
  });

  app.post("/api/cases/:id/browser/takeover", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = browserSessions.get(id);
    if (!session) return reply.code(404).send({ error: "no browser session" });
    await session.acquireByHuman();
    return { ok: true, controller: session.controller() };
  });

  app.post("/api/cases/:id/browser/release", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = browserSessions.get(id);
    if (!session) return reply.code(404).send({ error: "no browser session" });
    await session.releaseToLlm();
    return { ok: true, controller: session.controller() };
  });

  app.post("/api/cases/:id/facts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Partial<Parameters<FactStore["create"]>[1]>;
    // 直接 POST 的人工/外部调用可省略 source/value，补默认（agent 的 record_fact 工具同样补默认）
    const input = { value: {}, ...body, source: body.source ?? { type: "manual", ref: "api" } } as Parameters<FactStore["create"]>[1];
    let fact;
    try {
      fact = factStore.create(id, input);
    } catch (err) {
      return reply.code(400).send({ error: "invalid fact", reason: (err as Error).message });
    }
    const entry = timelineStore.append(id, "fact_created", `Fact: ${fact.title}`, fact.id);
    bus.emit({ type: "fact_created", fact });
    bus.emit({ type: "timeline_appended", entry });
    return fact;
  });

  app.get("/api/cases/:id/facts", async (req) => {
    const { id } = req.params as { id: string };
    return factStore.listByCase(id);
  });

  app.get("/api/cases/:id/artifacts", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return artifactStore.listByCase(id);
  });

  app.get("/api/cases/:id/artifact-analyzer-capabilities", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return Object.fromEntries(artifactStore.listByCase(id).map((artifact) => [
      artifact.id,
      artifactAnalyzers.capabilities(artifact),
    ]));
  });

  app.get("/api/cases/:id/artifact-analysis-attempts", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return artifactAttemptStore.listByCase(id);
  });

  app.get("/api/cases/:id/artifact-retry-authorizations", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return artifactRetryAuthorizationStore.listByCase(id);
  });

  app.get("/api/cases/:id/artifact-recoveries", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return artifactRecoveryStore.listByCase(id);
  });

  app.get("/api/cases/:id/artifact-limitations", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return artifactLimitationStore.listByCase(id);
  });

  app.get("/api/cases/:id/artifact-consumptions", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return artifactConsumptionSnapshot(id);
  });

  app.post("/api/cases/:id/tasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = (req.body ?? {}) as Parameters<TaskStore["create"]>[1];
    let task;
    try {
      task = taskStore.create(id, input);
    } catch (err) {
      return reply.code(400).send({ error: "invalid task", reason: (err as Error).message });
    }
    const entry = timelineStore.append(id, "task_created", `Task: ${task.title}`, task.id);
    bus.emit({ type: "task_created", task });
    bus.emit({ type: "timeline_appended", entry });
    return task;
  });

  app.get("/api/cases/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return taskStore.listByCase(id);
  });

  app.patch("/api/tasks/:taskId", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const { status, reason } = req.body as { status: Task["status"]; reason?: string };
    const current = taskStore.getById(taskId);
    if (!current) return reply.code(404).send({ error: "task not found" });
    const transition = evaluateRecordTaskValidationStatusTransition({ current, requestedStatus: status, patch: { status } });
    if (!transition.allowed) return reply.code(409).send({ error: transition.message });
    const task = taskStore.updateStatus(taskId, status, reason);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const entry = timelineStore.append(task.caseId, "task_updated", `Task ${task.title} → ${status}`, task.id);
    bus.emit({ type: "task_updated", task });
    bus.emit({ type: "timeline_appended", entry });
    emitValidationWorkflow(task.caseId, task.runId ?? undefined);
    return task;
  });

  app.get("/api/cases/:id/timeline", async (req) => {
    const { id } = req.params as { id: string };
    return timelineStore.listByCase(id, historyPageOptions(req.query));
  });

  app.get("/api/cases/:id/actions", async (req) => {
    const { id } = req.params as { id: string };
    return actionStore.listByCase(id);
  });

  app.get("/api/cases/:id/decisions", async (req) => {
    const { id } = req.params as { id: string };
    return decisionStore.listByCase(id);
  });

  app.get("/api/cases/:id/agent/events", async (req) => {
    const { id } = req.params as { id: string };
    return agentEventStore.listByCase(id, historyPageOptions(req.query));
  });

  app.get("/api/cases/:id/hypotheses", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return hypothesisStore.listByCase(id);
  });

  app.get("/api/cases/:id/validation/workflow", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    const query = (req.query ?? {}) as { runId?: string };
    const runId = query.runId || runs.getActiveByCase(id)?.run.id || runs.getLatestByCase(id)?.run.id;
    return buildValidationWorkflowSnapshot({
      caseId: id, runId, revision: currentValidationRevision(id), facts: factStore, hypotheses: hypothesisStore, tasks: taskStore,
      consensus: validationConsensusStore, artifacts: artifactStore, artifactAttempts: artifactAttemptStore, artifactLimitations: artifactLimitationStore, artifactAnalyzers, paths: attackPathStore, timeline: timelineStore,
      runtime: runId ? validationRuntimeByRun.get(runId) : undefined,
    });
  });

  app.get("/api/cases/:id/validation-conclusions", async (req) => {
    const { id } = req.params as { id: string };
    return validationConclusionStore.listByCase(id);
  });

  app.get("/api/cases/:id/validation-consensus", async (req) => {
    const { id } = req.params as { id: string };
    return validationConsensusStore.listByCase(id);
  });

  app.get("/api/cases/:id/identities", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return identityStore.listByCase(id);
  });

  app.get("/api/cases/:id/attack-paths", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return attackPathStore.listByCase(id);
  });

  app.get("/api/mcp/tools", async () => (mcp ? mcp.listTools() : []));

  app.get("/api/cases/:id/warnings", async (req) => {
    const { id } = req.params as { id: string };
    const { status, limit, offset } = req.query as { status?: string; limit?: string; offset?: string };
    const validStatus = ["open", "accepted", "dismissed", "converted_to_task"].includes(status ?? "")
      ? (status as ObserverWarning["status"])
      : undefined;
    return observerStore.listByCase(id, {
      status: validStatus,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  });

  app.get("/api/cases/:id/observer/strategy-audits", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    const { limit } = (req.query ?? {}) as { limit?: string };
    return {
      audits: observerStrategyAuditStore.listByCase(id, limit ? Number(limit) : 100),
    };
  });

  app.post("/api/observer/warnings/:warningId/accept", async (req, reply) => {
    const { warningId } = req.params as { warningId: string };
    const warning = observerStore.updateStatus(warningId, "accepted");
    if (!warning) return reply.code(404).send({ error: "warning not found" });
    bus.emit({ type: "observer_warning_updated", warning });
    return warning;
  });

  app.post("/api/observer/warnings/:warningId/dismiss", async (req, reply) => {
    const { warningId } = req.params as { warningId: string };
    const warning = observerStore.updateStatus(warningId, "dismissed");
    if (!warning) return reply.code(404).send({ error: "warning not found" });
    bus.emit({ type: "observer_warning_updated", warning });
    return warning;
  });

  app.post("/api/observer/warnings/:warningId/convert-task", async (req, reply) => {
    const { warningId } = req.params as { warningId: string };
    const cur = observerStore.getById(warningId);
    if (!cur) return reply.code(404).send({ error: "warning not found" });
    const task = taskStore.create(cur.caseId, {
      title: cur.title,
      status: "open",
      reason: `${cur.description}\n\nObserver suggestion: ${cur.suggestedAction}`,
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: cur.relatedFacts,
      priority: cur.level === "critical" ? "high" : cur.level === "warning" ? "medium" : "low",
    });
    const entry = timelineStore.append(cur.caseId, "task_created", `Task: ${task.title}`, task.id);
    const warning = observerStore.updateStatus(warningId, "converted_to_task");
    if (!warning) return reply.code(404).send({ error: "warning not found" });
    bus.emit({ type: "task_created", task });
    bus.emit({ type: "timeline_appended", entry });
    bus.emit({ type: "observer_warning_updated", warning });
    return { warning, task };
  });

  app.post("/api/cases/:id/scope/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { host } = (req.body ?? {}) as { host?: string };
    if (!host) return reply.code(400).send({ error: "host required" });
    const updated = cases.addAllowHost(id, host);
    if (!updated) return reply.code(404).send({ error: "case not found" });
    pendingInterventions.clearScope(id, host);
    agentEventStore.append(id, "done", `Scope approved: ${host}`);
    bus.emit({ type: "scope_updated", caseId: id, allowHosts: updated.scopeRules[0]?.allowHosts ?? [] });
    return updated;
  });

  app.get("/api/cases/:id/security-reports", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return securityReportStore.listByCase(id);
  });

  app.get("/api/cases/:id/security-reports/:reportId/export", async (req, reply) => {
    const { id, reportId } = req.params as { id: string; reportId: string };
    const { format = "markdown" } = req.query as { format?: string };
    const document = securityReportExport(db, reportId);
    if (!document || document.report.caseId !== id) return reply.code(404).send({ error: "security report not found" });
    const safeName = document.report.title.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "security-report";
    if (format === "json") {
      return reply.header("content-disposition", `attachment; filename="${safeName}.json"`)
        .type("application/json").send(document);
    }
    if (format !== "markdown") return reply.code(400).send({ error: "format must be markdown or json" });
    return reply.header("content-disposition", `attachment; filename="${safeName}.md"`)
      .type("text/markdown; charset=utf-8").send(securityReportMarkdown(document));
  });

  app.get("/api/cases/:id/security-reports/:reportId/revisions", async (req, reply) => {
    const { id, reportId } = req.params as { id: string; reportId: string };
    const report = securityReportStore.getById(reportId);
    if (!report || report.caseId !== id) return reply.code(404).send({ error: "security report not found" });
    return securityReportStore.listRevisions(reportId);
  });

  app.post("/api/cases/:id/security-reports/:reportId/revisions/:revisionId/accept", async (req, reply) => {
    const { id, reportId, revisionId } = req.params as { id: string; reportId: string; revisionId: string };
    const report = securityReportStore.getById(reportId);
    const revision = securityReportStore.listRevisions(reportId).find((item) => item.id === revisionId);
    if (!report || report.caseId !== id || !revision) return reply.code(404).send({ error: "report revision not found" });
    return securityReportStore.acceptRevision(revisionId);
  });

  app.post("/api/cases/:id/scope/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { host } = (req.body ?? {}) as { host?: string };
    if (!host) return reply.code(400).send({ error: "host required" });
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    pendingInterventions.clearScope(id, host);
    agentEventStore.append(id, "done", `Scope kept blocked: ${host}`);
    bus.emit({ type: "scope_expansion_rejected", caseId: id, host });
    return { rejected: true };
  });

  app.get("/api/cases/:id/interventions/pending", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cases.get(id)) return reply.code(404).send({ error: "case not found" });
    return pendingInterventions.get(id);
  });

  app.post("/api/cases/:id/agent/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });

    const { goal, budget, observerRecovery } = req.body as {
      goal: string;
      budget?: Partial<AgentRunBudget>;
      observerRecovery?: { warningId?: string; direction?: string };
    };
    if (!goal?.trim()) return reply.code(400).send({ error: "goal required" });
    const recoveryDirection = observerRecovery?.direction?.trim();
    const recoveryWarning = observerRecovery?.warningId
      ? observerStore.getById(observerRecovery.warningId)
      : undefined;
    if (observerRecovery) {
      if (!observerRecovery.warningId || !recoveryDirection) {
        return reply.code(400).send({ error: "observer recovery requires warningId and direction" });
      }
      if (!recoveryWarning || recoveryWarning.caseId !== id) {
        return reply.code(404).send({ error: "observer warning not found" });
      }
      if (recoveryWarning.correctionOutcome !== "stalled") {
        return reply.code(409).send({ error: "observer warning is not awaiting human direction" });
      }
    }
    const requestedGoal = recoveryDirection ?? goal.trim();
    const continuationState = isContinuationGoal(requestedGoal)
      ? sessionStore.getLatestByCase(id)
      : undefined;
    const effectiveGoal = isContinuationGoal(requestedGoal)
      ? runs.getLatestSubstantiveGoal(id) ?? continuationState?.currentGoal ?? requestedGoal
      : requestedGoal;
    reconcileEndpointFacts(id);
    let active;
    try {
      active = runs.start(id, effectiveGoal);
    } catch (err) {
      return reply.code(409).send({ error: "active run exists", reason: (err as Error).message });
    }
    if (continuationState) {
      sessionStore.upsert(id, {
        currentGoal: continuationState.currentGoal,
        phase: continuationState.phase,
        focus: continuationState.focus,
        activeHypothesisIds: continuationState.activeHypothesisIds,
      }, active.run.id);
    }
    if (recoveryWarning && recoveryDirection) {
      const warning = observerStore.beginHumanRecovery(
        recoveryWarning.id,
        active.run.id,
        recoveryDirection,
      );
      if (warning) {
        const entry = timelineStore.append(
          id,
          "observer_human_recovery_started",
          `Human direction opened a new Observer recovery window: ${recoveryDirection}`,
          warning.id,
          active.run.id,
        );
        bus.emit({ type: "observer_warning_updated", warning });
        bus.emit({ type: "timeline_appended", entry });
      }
    }
    for (const warning of observerStore.resolveActiveFromOtherRuns(id, active.run.id)) {
      bus.emit({ type: "observer_warning_updated", warning });
    }
    emitValidationWorkflowAudit(id);
    const resumedValidations = resumePendingValidations({
      caseId: id,
      runId: active.run.id,
      facts: factStore,
      hypotheses: hypothesisStore,
      tasks: taskStore,
      consensus: validationConsensusStore,
      timeline: timelineStore,
    });
    for (const task of resumedValidations.tasks) bus.emit({ type: "task_created", task });
    for (const entry of resumedValidations.timelineEntries) bus.emit({ type: "timeline_appended", entry });

    const runAgentInBackground = async (runId: string) => {
      const running = runs.get(runId);
      if (!running) return;
      const goal = running.run.goal;
      let llmConfig: ReturnType<typeof loadLlmConfig> | undefined;

      const recordRunUsage = (
        source: "agent" | "observer",
        usage: { promptTokens: number; completionTokens: number; totalTokens: number },
      ) => {
        const cost = calculateUsageCost(usage, llmConfig);
        const recorded = runs.addUsage(runId, { ...usage, source, ...cost });
        bus.emit({
          type: "agent_usage",
          caseId: id,
          runId,
          usageId: recorded?.usage.id ?? `usage_${randomUUID()}`,
          turn: recorded?.usage.turn ?? 1,
          source,
          createdAt: recorded?.usage.createdAt ?? new Date().toISOString(),
          ...usage,
          currency: recorded?.usage.currency ?? null,
          inputCostMicros: recorded?.usage.inputCostMicros ?? null,
          outputCostMicros: recorded?.usage.outputCostMicros ?? null,
          totalCostMicros: recorded?.usage.totalCostMicros ?? null,
          cumulativePromptTokens: recorded?.run.promptTokens ?? usage.promptTokens,
          cumulativeCompletionTokens: recorded?.run.completionTokens ?? usage.completionTokens,
          cumulativeTotalTokens: recorded?.run.totalTokens ?? usage.totalTokens,
        });
        return recorded;
      };
      const correctionAttribution = new ObserverCorrectionAttribution();
      for (const warning of observerStore.listByCase(id).warnings) {
        if (
          warning.relatedRunId === runId
          && observerHumanRecoveryWindowIsOpen(warning)
        ) {
          correctionAttribution.issue(warning);
        }
      }

      const runObserverReviewUnsafe = async (
        reviewRunId: string,
        reviewTrajectory: string,
        trigger: ObserverReviewTrigger,
        reviewTurn: number,
      ): Promise<{ action: "continue" | "pause"; reason?: string; steering?: string[] }> => {
        const startedAt = Date.now();
        const compact = (value: string | null | undefined, limit = 320) =>
          (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
        const currentFacts = factStore.listByCase(id);
        const currentTasks = taskStore.listByCase(id);
        const activeBeforeReview = observerStore.listByCase(id).warnings.filter((warning) =>
          warning.relatedRunId === reviewRunId
          && ["open", "detected", "correcting", "escalated"].includes(warning.status));
        const factsSummary = currentFacts
          .filter((fact) => fact.validity === "valid")
          .map((fact) => [
            `${fact.id} [${fact.type}; validity=${fact.validity}; finding=${fact.findingStatus ?? "n/a"}] ${fact.title}`,
            `evidenceRefs=${fact.evidenceRefs?.join(",") || "none"}`,
            `verification=${compact(fact.verificationSummary) || "none"}`,
            `observations=${fact.observations?.length ?? 0}`,
          ].join("; "))
          .join("\n") || "(none)";
        const tasksSummary = currentTasks.map((task) => [
          `${task.id} [${task.status}; priority=${task.priority}] ${task.title}`,
          `hypotheses=${task.hypothesisIds?.join(",") || "none"}`,
          `facts=${task.relatedFacts.join(",") || "none"}`,
          `blockedBy=${task.blockedBy.join(",") || "none"}`,
          `reason=${compact(task.reason) || "none"}`,
        ].join("; ")).join("\n") || "(none)";
        const artifactsSummary = artifactStore.listByCase(id).map((artifact) => {
          const artifactAttempts = artifactAttemptStore.listByArtifact(artifact.id);
          const aggregate = aggregateArtifactAnalysis(artifact, artifactAttempts);
          const analysisPlan = planArtifactAnalysis(artifact, artifactAnalyzers.capabilities(artifact), artifactAttempts);
          const recoveries = artifactRecoveryStore.listByCase(id).filter((item) => item.artifactId === artifact.id);
          const currentAttemptIds = artifactAttempts.map((attempt) => attempt.id).sort().join("\u0000");
          const limitations = artifactLimitationStore.listByCase(id).filter((item) =>
            item.artifactId === artifact.id
            && item.status === "accepted"
            && [...item.attemptIds].sort().join("\u0000") === currentAttemptIds);
          const linkedTasks = currentTasks.filter((task) => task.relatedFacts.some((factId) => {
            const fact = currentFacts.find((item) => item.id === factId);
            return fact?.source.type === "artifact_analysis" && fact.source.ref === artifact.id;
          }));
          return [
            `${artifact.id} [${artifact.status}; format=${artifact.detectedFormat}; bytes=${artifact.byteSize}] ${artifact.relativePath}`,
            `sha256=${artifact.sha256}`,
            `analyzers=${aggregate.analyzerIds.join(",") || "none"}`,
            `cumulativeCoverage=${aggregate.coveredDimensions.join(",") || "none"}`,
            `missingCoverage=${aggregate.missingDimensions.join(",") || "none"}`,
            `findings=${aggregate.findings.map((finding) => `${finding.kind}:${finding.label}=${finding.value}[sources=${finding.analyzerIds.join(",")}]`).join(" | ") || "none"}`,
            `limitations=${aggregate.limitations.map((item) => `${item.analyzerId}:${compact(item.detail)}`).join(" | ") || "none"}`,
            `analysisPlan=${analysisPlan.status}:${compact(analysisPlan.reason)}`,
            `recoveries=${recoveries.map((item) => `${item.id}:${item.status}:analyzer=${item.analyzerId}:task=${item.taskId}`).join(" | ") || "none"}`,
            `linkedTasks=${linkedTasks.map((task) => `${task.id}:${task.status}`).join(",") || "none"}`,
            `acceptedLimitations=${limitations.map((item) => `${item.id}:task=${item.taskId}:attempts=${item.attemptIds.join(",")}`).join(" | ") || "none"}`,
            "negativeConclusionSupportedByArtifactAlone=false",
          ].join("; ");
        }).join("\n") || "(none)";
        const activeWarningsSummary = activeBeforeReview.map((warning) => {
          const audit = parseObserverCorrectionAudit(warning.correctionEvidence);
          const previousCorrection = warning.suggestedGoal
            || warning.suggestedAction
            || audit?.instruction
            || "";
          return [
            `${warning.id} [${warning.status}; ${warning.level}; occurrences=${warning.occurrenceCount}]`,
            `identity=${warning.issueType}:${warning.subject || warning.title}`,
            `title=${warning.title}`,
            `evidence=${compact(warning.evidence) || "none"}`,
            `previousCorrection=${compact(previousCorrection) || "none"}`,
            `previousOutcome=${warning.correctionOutcome}`,
            `previousAttribution=${audit ? `${audit.reason}: ${compact(audit.summary)}` : compact(warning.correctionEvidence) || "none"}`,
            `previousActions=${audit?.actions.map((action) => `${action.tool}:${action.outcome}`).join(",") || "none"}`,
          ].join("; ");
        }).join("\n") || "(none)";
        const caseWarnings = observerStore.listByCase(id).warnings;
        const recoveryStrategySelection = selectVerifiedObserverRecoveryStrategies(
          caseWarnings,
          {
            excludeRunId: reviewRunId,
            maxCharacters: 2_400,
            focus: {
              goal,
              trajectory: reviewTrajectory,
              activeWarnings: activeBeforeReview,
            },
          },
        );
        const result = await new Observer(llm).review(id, {
          goal,
          trajectory: reviewTrajectory,
          factsSummary,
          tasksSummary,
          artifactsSummary,
          activeWarningsSummary,
          recoveryStrategiesSummary: recoveryStrategySelection.summary,
          recoveryStrategyIds: recoveryStrategySelection.strategies.map(
            (strategy) => strategy.warningId,
          ),
          reviewReason: trigger,
        });
        if (result.usage.totalTokens > 0) recordRunUsage("observer", result.usage);
        const warningIdsByStrategy = new Map<string, Set<string>>();
        const trackStrategyAdoptions = (strategyIds: string[], warningId: string) => {
          for (const strategyId of strategyIds) {
            const warningIds = warningIdsByStrategy.get(strategyId) ?? new Set<string>();
            warningIds.add(warningId);
            warningIdsByStrategy.set(strategyId, warningIds);
          }
        };
        const persistStrategyAudit = () => observerStrategyAuditStore.create(
          buildObserverStrategyAudit({
            caseId: id,
            runId: reviewRunId,
            trigger,
            selection: recoveryStrategySelection,
            warningIdsByStrategy,
          }),
        );
        if (result.error) {
          observerCadence.recordFailedReview(reviewTurn);
          const strategyAudit = persistStrategyAudit();
          bus.emit({
            type: "observer_review_failed",
            caseId: id,
            runId: reviewRunId,
            error: result.error,
            strategyAudit,
          });
          return { action: "continue" };
        }
        let pauseReason: string | undefined;
        const steering: string[] = [];
        const observedFingerprints = new Set<string>();
        const validFactIds = new Set(currentFacts
          .filter((fact) => fact.validity === "valid")
          .map((fact) => fact.id));
        const validTaskIds = new Set(currentTasks.map((task) => task.id));
        for (const w of result.warnings) {
          const level = validatedObserverLevel(w, validFactIds, validTaskIds);
          const fingerprint = observerFingerprint(w);
          observedFingerprints.add(fingerprint);
          const existing = observerStore.getActiveByFingerprint(id, reviewRunId, fingerprint)
            ?? observerStore.listByCase(id).warnings.find((candidate) =>
              candidate.relatedRunId === reviewRunId
              && ["open", "detected", "correcting", "escalated"].includes(candidate.status)
              && observerFingerprint(candidate) === fingerprint);
          if (existing) {
            const previousCorrection = existing.suggestedGoal || existing.suggestedAction;
            const previousAudit = parseObserverCorrectionAudit(existing.correctionEvidence);
            const humanRecoveryWindowOpen = observerHumanRecoveryWindowIsOpen(existing);
            let warning = observerStore.observeAgain(existing.id, {
              level,
              escalationReason: level === "critical"
                ? "Critical evidence remained unresolved after the Observer correction window."
                : null,
              suggestedAction: w.suggestedAction,
              suggestedGoal: w.suggestedGoal || w.suggestedAction,
              evidence: w.evidence,
              recoveryStrategyRefs: w.recoveryStrategyRefs,
            });
            if (!warning) continue;
            trackStrategyAdoptions(w.recoveryStrategyRefs, warning.id);
            warning = observerStore.settleCorrection(
              warning.id,
              warning.status === "escalated" ? "escalated" : "persisted",
              serializeObserverCorrectionAudit({
                version: 1,
                attributed: false,
                reason: "warning_reobserved",
                trigger: existing.lastCorrectionTrigger,
                instruction: previousCorrection,
                actions: [],
                evidenceRefs: [],
                summary: "The same warning was observed again after the correction window.",
              }),
            ) ?? warning;
            const proposedCorrection = warning.suggestedGoal || warning.suggestedAction;
            const stall = observerCorrectionStallDecision(
              existing,
              previousCorrection,
              proposedCorrection,
            );
            if (stall.stalled && humanRecoveryWindowOpen) {
              bus.emit({ type: "observer_warning_updated", warning });
              continue;
            }
            if (stall.stalled) {
              warning = observerStore.markCorrectionStalled(
                warning.id,
                serializeObserverCorrectionAudit({
                  version: 1,
                  attributed: false,
                  reason: "no_novel_strategy",
                  trigger: existing.lastCorrectionTrigger,
                  instruction: previousCorrection,
                  actions: previousAudit?.actions ?? [],
                  evidenceRefs: previousAudit?.evidenceRefs ?? [],
                  summary: stall.pauseReason
                    ? "The issue remains Critical, but the Observer produced no materially new correction. Human direction is required."
                    : "The issue remains active, but the Observer produced no materially new correction. Periodic review was reduced.",
                }),
              ) ?? warning;
              if (stall.pauseReason && !pauseReason) {
                pauseReason = stall.pauseReason;
                bus.emit({
                  type: "agent_run_needs_confirmation",
                  caseId: id,
                  runId: reviewRunId,
                  warning,
                });
              }
              bus.emit({ type: "observer_warning_updated", warning });
              continue;
            }
            const intervention = observerIntervention(warning, {
              allowPause: trigger === "high_risk" || trigger === "evidence_conflict",
            });
            if (intervention.pauseReason && !pauseReason) {
              pauseReason = intervention.pauseReason;
              bus.emit({ type: "agent_run_needs_confirmation", caseId: id, runId: reviewRunId, warning });
            } else if (intervention.steering) {
              steering.push(intervention.steering);
              warning = observerStore.recordCorrection(warning.id, trigger) ?? warning;
              correctionAttribution.issue(warning);
            }
            bus.emit({ type: "observer_warning_updated", warning });
            continue;
          }
          const now = new Date().toISOString();
          let warning = observerStore.create({
            ...w,
            level,
            status: initialObserverStatus(level),
            fingerprint,
            occurrenceCount: 1,
            lastObservedAt: now,
            escalationReason: null,
            relatedRunId: reviewRunId,
            suggestedGoal: w.suggestedGoal || w.suggestedAction,
            resolvedAt: null,
          });
          trackStrategyAdoptions(w.recoveryStrategyRefs, warning.id);
          const intervention = observerIntervention(warning, { allowPause: false });
          if (intervention.steering) {
            steering.push(intervention.steering);
            warning = observerStore.recordCorrection(warning.id, trigger) ?? warning;
            correctionAttribution.issue(warning);
          }
          bus.emit({ type: "observer_warning", warning });
        }
        for (const warning of activeBeforeReview) {
          if (observedFingerprints.has(warning.fingerprint)) continue;
          const attribution = correctionAttribution.assess(warning.id);
          const settled = observerStore.settleCorrection(
            warning.id,
            attribution.attributed ? "resolved" : "unattributed",
            serializeObserverCorrectionAudit(attribution.audit),
          ) ?? warning;
          if (attribution.attributed) {
            const resolved = observerStore.updateStatus(settled.id, "resolved");
            if (resolved) bus.emit({ type: "observer_warning_updated", warning: resolved });
          } else {
            bus.emit({ type: "observer_warning_updated", warning: settled });
          }
        }
        observerCadence.recordSuccessfulReview(reviewTurn, {
          warningCount: result.warnings.length,
          correctionCount: steering.length,
        });
        const strategyAudit = persistStrategyAudit();
        bus.emit({
          type: "observer_review_completed",
          caseId: id,
          runId: reviewRunId,
          trigger,
          warningCount: result.warnings.length,
          correctionCount: steering.length,
          durationMs: Date.now() - startedAt,
          totalTokens: result.usage.totalTokens,
          strategyAudit,
        });
        return pauseReason
          ? { action: "pause", reason: pauseReason }
          : { action: "continue", steering };
      };
      let observerReviewInFlight: Promise<{ action: "continue" | "pause"; reason?: string; steering?: string[] }> | null = null;
      let lastObserverReviewDigest = "";
      const runObserverReview = async (
        reviewRunId: string,
        reviewTrajectory: string,
        trigger: ObserverReviewTrigger,
        reviewTurn: number,
      ): Promise<{ action: "continue" | "pause"; reason?: string; steering?: string[] }> => {
        const normalizedTrajectory = reviewTrajectory.trim();
        if (!normalizedTrajectory) return { action: "continue" };
        const digest = createHash("sha256").update(normalizedTrajectory).digest("hex");
        if (digest === lastObserverReviewDigest || observerReviewInFlight) return { action: "continue" };
        lastObserverReviewDigest = digest;
        observerReviewInFlight = runObserverReviewUnsafe(reviewRunId, normalizedTrajectory, trigger, reviewTurn);
        try {
          return await observerReviewInFlight;
        } catch (error) {
          observerCadence.recordFailedReview(reviewTurn);
          bus.emit({
            type: "observer_review_failed",
            caseId: id,
            runId: reviewRunId,
            error: (error as Error).message,
          });
          return { action: "continue" };
        } finally {
          observerReviewInFlight = null;
        }
      };

    const registry = new ToolRegistry();
    const runTimeline = {
      append: (caseId: string, eventType: string, detail: string, refId?: string) =>
        timelineStore.append(caseId, eventType, detail, refId, runId),
    };
    registry.register(makeListTrafficTool(id, traffic));
    registry.register(makeGetTrafficTool(id, traffic));
    registry.register(makeRecordFactTool(id, factStore, runTimeline, (e) => bus.emit(e), runId));
    registry.register(makeRecordTaskTool(
      id,
      taskStore,
      runTimeline,
      (e) => bus.emit(e),
      runId,
      hypothesisStore,
      (task) => {
        const currentFacts = factStore.listByCase(id);
        return combineTaskCompletionGates(
          evaluateValidationTaskCompletion({
            task,
            facts: currentFacts,
            consensus: validationConsensusStore.listByCase(id),
            hypotheses: hypothesisStore.listByCase(id),
          }),
          evaluateArtifactTaskReadiness({
            task,
            facts: currentFacts,
            artifacts: artifactStore.listByCase(id),
            attempts: artifactAttemptStore.listByCase(id),
            dispositions: artifactLimitationStore.listByCase(id),
            capabilitiesByArtifact: Object.fromEntries(artifactStore.listByCase(id).map((artifact) => [artifact.id, artifactAnalyzers.capabilities(artifact)])),
          }),
        );
      },
      (current, requestedStatus, patch) => evaluateRecordTaskValidationStatusTransition({
        current, requestedStatus, patch, tasks: taskStore.listByCase(id),
      }),
    ));
    registry.register(makeManageValidationTaskTool({
      caseId: id,
      runId,
      facts: factStore,
      hypotheses: hypothesisStore,
      tasks: taskStore,
      consensus: validationConsensusStore,
      artifacts: artifactStore,
      artifactAttempts: artifactAttemptStore,
      artifactLimitations: artifactLimitationStore,
      artifactAnalyzers,
      timeline: timelineStore,
      emit: (event) => bus.emit(event),
    }));
    registry.register(makeGetValidationWorkflowStateTool(() => buildValidationWorkflowSnapshot({
      caseId: id, runId, revision: currentValidationRevision(id), facts: factStore, hypotheses: hypothesisStore, tasks: taskStore,
      consensus: validationConsensusStore, artifacts: artifactStore, artifactAttempts: artifactAttemptStore, artifactLimitations: artifactLimitationStore, artifactAnalyzers, paths: attackPathStore, timeline: timelineStore,
      runtime: validationRuntimeByRun.get(runId),
    })));
    registry.register(makeRecordActionTool(
      id,
      factStore,
      actionStore,
      decisionStore,
      runTimeline,
      (e) => bus.emit(e),
      { hypotheses: hypothesisStore, tasks: taskStore },
    ));
    registry.register(makeReopenTaskTool(id, taskStore, taskStore, factStore, runTimeline, (e) => bus.emit(e)));
    registry.register(makeRevertDoneTaskTool(id, taskStore, taskStore, factStore, runTimeline, (e) => bus.emit(e)));
    registry.register(makeListIdentitiesTool(id, identityStore));
    registry.register(makeRecordIdentityTool(id, identityStore, runTimeline, (e) => bus.emit(e)));
    registry.register(makeListAttackPathsTool(id, attackPathStore));
    registry.register(makeRecordAttackPathTool(id, runId, attackPathStore, runTimeline, (e) => bus.emit(e)));
    registry.register(makeListSecurityReportsTool(id, securityReportStore));
    registry.register(makeRecordSecurityReportTool(id, runId, securityReportStore, runTimeline, (e) => bus.emit(e)));
    const replayIdentityContext = {
      runId,
      resolveIdentity: (identityId: string) => {
        const identity = identityStore.getById(identityId);
        return identity?.caseId === id ? identity : undefined;
      },
    };
    registry.register(makeHttpReplayTool(c.scopeRules, undefined, id, traffic, (e) => bus.emit(e), replayIdentityContext));
    registry.register(makeReplayTrafficTool(c.scopeRules, traffic, undefined, id, traffic, (e) => bus.emit(e), replayIdentityContext));
    registry.register(makeCompareIdentityTrafficTool(c.scopeRules, traffic, identityStore, undefined, id, traffic, (e) => bus.emit(e), runId));
    registry.register(makeAssessValidationExperimentTool(id, traffic));
    registry.register(makeRecordValidationConclusionTool({
      caseId: id,
      runId,
      facts: factStore,
      traffic,
      conclusions: validationConclusionStore,
      consensus: validationConsensusStore,
      timeline: timelineStore,
      tasks: taskStore,
      emit: (event) => bus.emit(event),
    }));
    registry.register(makeExtractApiEndpointsTool(id, c.scopeRules, {
      traffic,
      facts: factStore,
      timeline: runTimeline,
      emit: (e) => bus.emit(e),
      analyze: async (text, context) => {
        const res = await llm.extractJson({
          system: `你是 API 端点提取器。给定一段原始文本（HTTP 响应体或 JS 代码），只提取其中明确出现的 API 端点和参数。禁止编造、推断或补全未在文本中出现的内容。对每个候选必须给出逐字证据片段。`,
          user: `来源类型：${context.sourceType}\n基础 URL：${context.baseUrl ?? "无"}\n\n原始文本：\n${text.slice(0, 20000)}`,
          schema: {
            type: "object",
            properties: {
              endpoints: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    method: { type: "string" },
                    parameters: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          required: { type: "boolean" },
                          location: { type: "string" },
                          note: { type: "string" },
                        },
                        required: ["name"],
                      },
                    },
                    evidence: { type: "string", description: "从原始文本中逐字拷贝的片段" },
                  },
                  required: ["url", "evidence"],
                },
              },
            },
            required: ["endpoints"],
          },
        });
        return ((res as { endpoints?: unknown }).endpoints as Array<{ url: string; method?: string; parameters?: unknown; evidence: string }> | undefined)?.map((e) => ({
          url: typeof e.url === "string" ? e.url : "",
          method: typeof e.method === "string" ? e.method : undefined,
          evidence: typeof e.evidence === "string" ? e.evidence : "",
          parameters: Array.isArray(e.parameters)
            ? e.parameters
              .filter((p: unknown): p is Record<string, unknown> => typeof p === "object" && p !== null)
              .map((p) => ({
                name: typeof p.name === "string" ? p.name : "",
                required: typeof p.required === "boolean" ? p.required : undefined,
                location: ["query", "body", "path"].includes(typeof p.location === "string" ? p.location : "") ? (p.location as "query" | "body" | "path") : undefined,
                note: typeof p.note === "string" ? p.note : undefined,
              }))
              .filter((p) => p.name !== "")
            : undefined,
        })).filter((e) => e.url !== "" && e.evidence !== "") ?? [];
      },
    }));
    registry.register(makeProposeScopeExpansionTool((host, reason) => {
      pendingInterventions.setScope(id, { host, reason });
      bus.emit({ type: "scope_expansion_proposed", caseId: id, host, reason });
    }));
    registry.register(makeUpdateSessionStateTool(id, sessionStore, runId));
    registry.register(makeRecordHypothesisTool(id, hypothesisStore, factStore, runId));
    registry.register(makeResolveHypothesisTool(id, hypothesisStore, factStore));
    registry.register(makeSearchFactsTool(id, factStore, { expander: queryExpander }));
    registry.register(makeGetFactDetailTool(id, factStore));
    registry.register(makeSearchTrafficTool(id, traffic));
    registry.register(makeRecallConversationTool(id, agentEventStore, contextSummaryStore, { expander: queryExpander }));
    const availableKnowledge = new Map<string, KnowledgeRef>();
    const knowledgeOutcomeTracker = new KnowledgeOutcomeTracker();
    const evidenceConsumptionTracker = new EvidenceConsumptionTracker();
    let latestSharedKnowledge: ReturnType<typeof buildSharedKnowledge> | undefined;
    const getSharedKnowledge = (query?: string) => {
      const runState = sessionStore.get(id, runId);
      const knowledge = buildSharedKnowledge({
        facts: factStore.listByCase(id),
        identities: identityStore.listByCase(id),
        attackPaths: attackPathStore.listByCase(id),
        usageScores: knowledgeUsageStore.scores(id, runId),
      }, runId, {
        goal: query?.trim() || runState?.currentGoal || goal,
        phase: runState?.phase,
        host: runState?.focus.host,
        url: runState?.focus.url,
        note: query?.trim() || runState?.focus.note,
      });
      for (const ref of knowledge.injectedKnowledgeRefs ?? []) availableKnowledge.set(`${ref.kind}:${ref.id}`, ref);
      knowledgeUsageStore.recordInjected(id, runId, knowledge.injectedKnowledgeRefs ?? []);
      latestSharedKnowledge = knowledge;
      return knowledge;
    };
    registry.register(makeRecallCaseKnowledgeTool({ get: getSharedKnowledge }));
    const getAttackPathPlan = () => formatAttackPathPlan(rankAttackPathBreakpoints({
      paths: attackPathStore.listByCase(id),
      hypotheses: hypothesisStore.listByCase(id).filter((item) => item.runId === runId),
      tasks: taskStore.listByCase(id).filter((item) => item.runId === runId),
      goal: sessionStore.get(id, runId)?.currentGoal || goal,
    }));
    const getEvidenceGaps = () => mapEvidenceGaps({
      facts: factStore.listByCase(id),
      paths: attackPathStore.listByCase(id),
      traffic: traffic.listByCase(id),
      identities: identityStore.listByCase(id),
    });
    const getEvidenceGapPlan = () => formatEvidenceGapPlan(getEvidenceGaps());
    const getValidationMatrixPlan = () => formatValidationMatrices(buildValidationMatrices({
      gaps: getEvidenceGaps(),
      traffic: traffic.listByCase(id),
      identities: identityStore.listByCase(id),
    }));
    registry.register(makeReevaluateFactsTool(id, factStore, async (_cid, goal, focus, facts) => {
      const factsText = facts.map((f) => `${f.id} [${f.type}] ${f.title}: ${JSON.stringify(f.value)}`).join("\n") || "(无)";
      const res = await llm.extractJson({
        system: `你是 TraceForge 的辅助分析器。给定当前目标和已有 Facts，指出哪些 Facts 可以被利用、如何利用，并给出下一步具体建议。只返回建议，不要执行任何操作。`,
        user: `目标：${goal}\n聚焦：${focus ?? "(无)"}\n\n已有 Facts：\n${factsText}`,
        schema: { type: "object", properties: { suggestion: { type: "string" } }, required: ["suggestion"] },
      });
      return (res as { suggestion?: string }).suggestion ?? "No suggestion.";
    }));
    await registerExistingCaseArtifacts(id, projectRoot, artifactStore);
    registry.register(makeDownloadTool({
      caseId: id,
      workspaceRoot: projectRoot,
      onDownloaded: (artifact) => {
        const record = artifactStore.record({
          caseId: id,
          runId,
          sourceUrl: artifact.sourceUrl,
          filename: artifact.filename,
          relativePath: artifact.relativePath,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
          detectedFormat: artifact.detectedFormat,
          mediaType: null,
        });
        bus.emit({ type: "artifact_updated", artifact: record });
        return record;
      },
    }));
    registry.register(makeListArtifactsTool(id, artifactStore, artifactAnalyzers, artifactAttemptStore));
    registry.register(makePlanArtifactAnalysisTool(id, artifactStore, artifactAnalyzers, artifactAttemptStore));
    registry.register(makeAuthorizeArtifactRetryTool({
      caseId: id, runId, artifacts: artifactStore, attempts: artifactAttemptStore,
      analyzers: artifactAnalyzers, authorizations: artifactRetryAuthorizationStore,
      timeline: timelineStore, emit: (event) => bus.emit(event),
    }));
    registry.register(makeManageArtifactRecoveryTool({
      caseId: id, runId, artifacts: artifactStore, attempts: artifactAttemptStore,
      analyzers: artifactAnalyzers, recoveries: artifactRecoveryStore,
      tasks: taskStore, timeline: timelineStore, emit: (event) => bus.emit(event),
      onReplan: (message) => runs.addRuntimeMessage(runId, message),
    }));
    registry.register(makeManageArtifactLimitationTool({
      caseId: id, runId, artifacts: artifactStore, attempts: artifactAttemptStore, analyzers: artifactAnalyzers,
      limitations: artifactLimitationStore, facts: factStore, tasks: taskStore, timeline: timelineStore,
      emit: (event) => bus.emit(event),
    }));
    registry.register(makeAnalyzeArtifactTool(id, projectRoot, artifactStore, artifactAnalyzers, {
      attempts: artifactAttemptStore,
      runId,
      onAttemptChanged: (attempt) => bus.emit({ type: "artifact_analysis_attempt_updated", attempt }),
      retryAuthorizations: artifactRetryAuthorizationStore,
      onRetryAuthorizationChanged: (authorization) => {
        bus.emit({ type: "artifact_retry_authorization_updated", authorization });
        if (authorization.status === "consumed") {
          const entry = timelineStore.append(id, "artifact_retry_consumed", `Artifact=${authorization.artifactId}; analyzer=${authorization.analyzerId}; authorization=${authorization.id}`, authorization.artifactId, runId);
          bus.emit({ type: "timeline_appended", entry });
        }
      },
      onChanged: (artifact, reason) => {
        bus.emit({ type: "artifact_updated", artifact });
        if (reason === "analyzing") return;
        if (reason === "analyzed" && artifact.analysis) {
          const entry = timelineStore.append(id, "artifact_analyzed", artifact.analysis.summary, artifact.id, runId);
          bus.emit({ type: "timeline_appended", entry });
        } else if (reason === "unsupported" || reason === "failed") {
          const entry = timelineStore.append(
            id,
            "artifact_analysis_unavailable",
            `Artifact=${artifact.id}; status=${artifact.status}; limitation=${artifact.error ?? "no compatible analysis result"}`,
            artifact.id,
            runId,
          );
          bus.emit({ type: "timeline_appended", entry });
        }
        syncArtifactEvidenceFacts(artifact);
        const artifactFacts = factStore.listByCase(id).filter((fact) =>
          fact.source.type === "artifact_analysis" && fact.source.ref === artifact.id);
        const lifecycle = connectArtifactEvidenceLifecycle({
          runId,
          artifact,
          attempts: artifactAttemptStore.listByArtifact(artifact.id),
          artifactFacts,
          facts: factStore,
          tasks: taskStore,
          timeline: timelineStore,
          emit: (event) => bus.emit(event),
        });
        if (lifecycle.runtimeMessage && lifecycle.task) {
          const trackedEvidence = artifactEvidenceForConsumption(lifecycle.facts);
          const refs = trackedEvidence.map((item) => item.ref);
          for (const ref of refs) availableKnowledge.set(`${ref.kind}:${ref.id}`, ref);
          knowledgeUsageStore.recordInjected(id, runId, refs);
          evidenceConsumptionTracker.register(lifecycle.task.id, trackedEvidence);
          runs.addRuntimeMessage(runId, lifecycle.runtimeMessage);
          emitArtifactConsumptionSnapshot(id);
        }
      },
    }));

    // 若该 case 有共享浏览器会话，把浏览器工具纳入 agent 工具集
    // 若配置了 MCP server，把其工具纳入 agent 工具集；工具名直接使用 MCP toolName。
    if (mcp) {
      for (const h of mcp.listTools()) registry.register(mcpToolToDescriptor(h, mcp, { caseId: id }));
    }

    activeToolRegistries.set(id, { runId, registry, browserAttached: false, displaced: new Map() });
    const browserSession = browserSessions.get(id);
    if (browserSession) attachBrowserTools(id, browserSession);

    const gate = new ApprovalGate(async (tool, input) => {
      const approvalId = `appr_${randomUUID()}`;
      const serializedInput = JSON.stringify(input);
      pendingInterventions.setApproval(id, { approvalId, tool: tool.name, input: serializedInput });
      bus.emit({ type: "approval_requested", caseId: id, approvalId, tool: tool.name, input: serializedInput });
      const decision = await approvals.request(approvalId, running.abortController.signal);
      pendingInterventions.clearApproval(id, approvalId);
      agentEventStore.append(id, "validation", `Approval ${decision}: ${tool.name}`, tool.name);
      bus.emit({ type: "approval_resolved", caseId: id, approvalId, tool: tool.name, decision });
      return decision;
    });

    const allowHosts = c.scopeRules.flatMap((r) => r.allowHosts);
    const scopeGuidance =
      allowHosts.length === 0
        ? `当前授权范围为空（用户新建 Case 时未预先指定边界）。
你的首要职责是从用户这次对话的目标里识别出需要测试的目标 host/域名/IP，然后调用 propose_scope_expansion(host, reason) 提议把它纳入授权范围，等用户批准后再发起任何对外请求。
在用户批准纳入之前，绝不要对任何 host 发包（http_replay / navigate 都会被 Scope Guard 拦截）。如果从对话里识别不出明确目标，就直接询问用户要测哪个目标，不要擅自猜测或测试任意 host。`
        : `当前授权范围：${JSON.stringify(c.scopeRules)}。如需测试范围外的 host，先用 propose_scope_expansion 提议并等用户批准。`;
    const system = `你是 TraceForge 的授权渗透测试 agent。${scopeGuidance}
你可以用工具查看流量、记录发现（Fact/Task/Action）、重放请求。黑盒流程：先 navigate/extract_links 访问首页，再用 extract_api_endpoints 从流量中提取接口并记录为 Fact，然后用 replay_traffic 或 http_replay 构造变体请求测试漏洞。如需进一步利用（写 PoC、跑脚本、读取命令输出），可调用 MCP 工作区工具：exec_command 执行 shell 命令、write_file 写文件、read_file 读文件、list_dir 列目录；这些命令受限于当前 Case 的 workspace/<caseId>/ 目录并需要用户批准。
证据驱动：记录动作前先记录支撑它的 Fact。
情报复用：遇到任何可能有关的信息（端点、参数、版本号、错误信息、凭据线索、技术栈、WAF 行为、异常响应）都要立即记录为 Fact，即使不确定是否有用。后续在采取任何攻击动作前，先用 search_facts 检索相关 Fact 并尝试利用其中的价值。
Artifact 证据：download_tool 成功只证明文件已获取。下载后用 list_artifacts 获取持久记录，调用 plan_artifact_analysis 根据覆盖缺口与尝试历史选择下一种方法，然后一次只调用一个 analyze_artifact。每次分析结束后重新规划，禁止并行启动多个 Analyzer。优先使用结构化关系分析，不要只依赖原始字符串扫描。掩码/脱敏值只证明输出被处理，不能证明原值不存在；分析器不支持、执行失败、覆盖不足或未命中时，只能记录未解决和分析限制，禁止下“内容不存在”的结论。
当 plan_artifact_analysis 返回 recovery_required 时，使用 manage_artifact_recovery 将恢复附着在当前 Task：先 plan，再 start，完成外部恢复动作后 verify。verify 会强制刷新 Preflight，只有环境身份指纹真实变化且分析器可用性改善才会成功，并自动把重新规划结果注入当前 Run。环境未变化时 retry=true 不会绕过保护，只有确有理由时才调用 authorize_artifact_retry 取得一次性人工批准。恢复失败必须记录 fail，不能把它当作路径耗尽。只有规划明确返回 blocked 或 exhausted，且当前所有兼容分析路径均已用尽时，才可调用 manage_artifact_limitation 接受该 Task 的残余限制并说明理由。该记录只允许结束关联 Task 的生命周期，绝不能验证或否定安全发现；任何新的分析尝试都会使旧记录失效，之后必须重新评估。
认证端点测试顺序：当目标涉及登录或认证接口时，按以下顺序执行：
1. 先尝试一组常见/弱口令凭据（可控数量，不要无差别爆破）；
2. 复用从其他 Facts 中发现的疑似凭据或线索；
3. 若上述尝试均失败，记录一条说明阻塞原因的 Fact，然后再 pivot 到相邻攻击面（注册接口、找回密码、OAuth、会话管理、越权等）。
完成后用一句话总结。
失败记忆与在线工具回退：
- 禁止用完全相同的输入重复调用任何已经执行失败的工具（尤其是 exec_command 和脚本类调用）。运行时会自动记忆工具失败；不要把参数校验、生命周期或引用错误手工记录为安全 Fact。应修正输入或更新当前 Task/Hypothesis 后换用其他方法。
- 如果流量响应是二进制且 get_traffic 只返回元数据或 body=null，使用 download_tool 将原始授权 URL 保存到本 Case 的 downloads 目录，再通过文件分析工具处理；不要反复读取不存在的 body。
- 如果当前环境无法解决问题，调用 download_tool(url, filename, executable=true) 从网络下载现成工具，保存到 workspace/<caseId>/downloads/，然后通过 exec_command 执行（仍需用户批准）。
- 重试相同失败输入会被 runtime 自动拒绝，不要一直重复尝试，不要浪费轮次。`;

    const runtimeProtocol = `
[Runtime environment]
- Host platform: ${process.platform}; ${process.platform === "win32" ? "exec_command uses cmd.exe. Do not use POSIX utilities, /dev/null, ||, or &&." : "shell commands must be compatible with this platform."}
- Current case id: ${id}. Workspace tools are server-bound to this case; never invent or reuse a caseId.
- Never print binary files to stdout. For binary artifacts, record path, byte size, hash, format and a short analysis summary.
- Repeated non-informative attempts are grouped by objective, technique and observed outcome. Pivot after the evidence gap is no longer changing.

[Evidence and hypothesis loop]
- Keep broad ideas in one hypothesis pool. Before repeated active testing of a suspected weakness, record or update one hypothesis and attach a concrete validation task.
- When several suspicious points exist, create one Hypothesis and one queued Task for each point. Only one Task may be running in a Run.
- Finish, block, reject, or explicitly release the current Task before starting the next queued Task. Never interleave separate validation tracks.
- Facts are observations. A vulnerability remains candidate/validating until the evidence demonstrates a reproducible causal mechanism, attributable source, concrete security impact and an auditable evidence chain. No single signal automatically verifies a finding.
- After a meaningful result, update the hypothesis/task instead of issuing more variants without a stated evidence gap.
- This protocol organizes exploration; it does not forbid related targets already inside the authorized scope or suppress useful plaintext clues.
`;

    // Failed executions are Run-local operational state. They remain available
    // through persisted agent events, but must not become cross-Run knowledge.
    const failureMemory = new FailureMemory();

    const trajectory: string[] = [];

    // 先取历史（此时不含当前 goal），构造近期对话
    const history = agentEventStore.listByCase(id);
    const recentConvo = history
      .filter((e) => e.kind === "user" || e.kind === "done")
      .slice(-20)
      .map((e) => ({ role: e.kind === "user" ? ("user" as const) : ("assistant" as const), text: e.text }));
    try {
      llmConfig = llmService?.load() ?? loadLlmConfig() ?? undefined;
    } catch {
      llmConfig = loadLlmConfig() ?? undefined;
    }
    const contextBudget = deriveContextBudget({
      contextWindowTokens: llmConfig?.contextWindowTokens,
      maxOutputTokens: llmConfig?.maxOutputTokens,
    });
    let validationFeedback = recoverValidationFeedback(timelineStore.listByCase(id));
    const captureValidationOutcome = (): ValidationOutcomeSnapshot => {
      const evidenceFacts = factStore.listByCase(id);
      const evidenceTraffic = traffic.listByCase(id);
      return {
      evidenceCount: evidenceFacts.length + evidenceTraffic.length,
      evidenceSignature: JSON.stringify({
        facts: evidenceFacts.map((fact) => ({ id: fact.id, updateCount: fact.updateCount, validity: fact.validity, observations: fact.observations?.length ?? 0 })),
        traffic: evidenceTraffic.map((entry) => ({ id: entry.id, status: entry.responseStatus, size: entry.responseSize })),
      }),
      consensusSignature: JSON.stringify(validationConsensusStore.listByCase(id)),
      attackPathSignature: JSON.stringify(attackPathStore.listByCase(id).map((path) => ({
        id: path.id, status: path.status, version: path.version, evidenceRefs: path.evidenceRefs,
      }))),
    };
    };
    const rankedTasks = rankValidationTasks({
      tasks: taskStore.listByCase(id).filter((task) =>
        task.runId === runId && ["open", "blocked", "running", "recheck_candidate"].includes(task.status)),
      facts: factStore.listByCase(id),
      consensus: validationConsensusStore.listByCase(id),
      paths: attackPathStore.listByCase(id),
      feedback: summarizeValidationFeedbackHistory(validationFeedback),
    });
    let currentValidationPriority = validationPriorityLeader(rankedTasks);
    let validationExplorationState = initialValidationExplorationState();
    const syncValidationRuntime = () => {
      validationRuntimeByRun.set(runId, {
        leader: currentValidationPriority,
        exploration: validationExplorationState,
      });
      emitValidationWorkflow(id, runId);
    };
    syncValidationRuntime();
    const initiallyRunningValidation = rankedTasks.find((item) => item.validation && item.task.status === "running")?.task;
    const initiallyRunningFindingId = initiallyRunningValidation ? validationFindingId(initiallyRunningValidation) : undefined;
    let executingValidationTask = initiallyRunningValidation && initiallyRunningFindingId
      ? { taskId: initiallyRunningValidation.id, findingId: initiallyRunningFindingId }
      : undefined;
    let executingTaskId = rankedTasks.find((item) => item.task.status === "running")?.task.id;
    let validationOutcomeBefore: ValidationOutcomeSnapshot | undefined;
    const priorityDetail = formatValidationTaskPriorities(rankedTasks);
    if (priorityDetail) {
      const entry = timelineStore.append(id, "validation_tasks_prioritized", priorityDetail, undefined, runId);
      bus.emit({ type: "timeline_appended", entry });
    }
    const built = buildContext({
      goal,
      state: sessionStore.get(id, runId),
      recentConvo,
      factCount: factStore.listByCase(id).length,
      trafficCount: traffic.listByCase(id).length,
      summaryCount: contextSummaryStore.latest(id) ? 1 : 0,
      activeHypotheses: hypothesisStore.listByCase(id).filter((h) => h.runId === runId && h.status === "active"),
      activeTasks: rankedTasks.map((item) => item.task),
      taskPriorities: Object.fromEntries(rankedTasks.map((item) => [item.task.id, { score: item.score, reasons: item.reasons }])),
      doneTaskSummaries: taskStore.listByCase(id).filter((t) => t.runId === runId && t.status === "done").map((t) => `${t.title}：${t.reason || "完成"}`),
      farSummary: contextSummaryStore.latest(id)?.content,
      scopeHosts: c.scopeRules.flatMap((r) => r.allowHosts),
      sharedKnowledge: getSharedKnowledge(),
    }, { maxTokens: contextBudget.maxTokens, focusReserve: contextBudget.focusReserve });

    agentEventStore.append(id, "user", goal); // 存用户这句目标，刷新/切 Case 后历史可见完整双边对话
    agentEventStore.append(id, "started", `Started: ${goal}`);
    // tool 事件 refs 联动:run 级缓冲收集本 case 的 timeline 条目,
    // onBeforeToolExecute/onToolExecuted 夹出每个工具的执行窗口,
    // 按工具名 FIFO 与 tool_result 事件配对(批量结果按调用顺序发出,两钩子严格一一对应)。
    // 并行批次中窗口可能重叠,写工具的产出会同时落入只读批友的窗口——可接受的重复,不写死工具名。
    const runTimelineEntries: TimelineEntry[] = [];
    const offTimelineCollect = bus.subscribe((event) => {
      if (event.type === "timeline_appended" && event.entry.caseId === id) runTimelineEntries.push(event.entry);
    });
    const toolRefWindows = new Map<string, number[]>();
    const pendingToolRefs = new Map<string, (AgentEventRefs | null)[]>();
    const observerScheduler = new ObserverScheduler();
    const observerCadence = new ObserverCadence();
    const structurePolicy = new InvestigationStructurePolicy();
    await new AgentRuntime(llm, registry, gate).run(
      `${system}\n${runtimeProtocol}\nValidation task protocol: use manage_validation_task to claim a consensus validation task before executing it, release it before pivoting, and complete it only after recording the required evidence. Do not manually change consensus validation status with record_task.\n\n${getAttackPathPlan()}\n\n${getEvidenceGapPlan()}\n\n${getValidationMatrixPlan()}`,
      built.messages,
      (e) => {
      if (e.type === "tool_call") {
        const executionId = e.executionId ?? `exec_${randomUUID()}`;
        bus.emit({ type: "agent_tool_call", caseId: id, runId, executionId, tool: e.name ?? "", input: e.content });
        agentEventStore.append(
          id, "tool_call", `${e.name}(${e.content})`, e.name ?? undefined, undefined, undefined,
          { runId, executionId, outcome: "running" },
        );
        trajectory.push(`[tool] ${e.name}(${e.content})`);
      }
      else if (e.type === "tool_result") {
        const refsQueue = pendingToolRefs.get(e.name ?? "");
        const refs = refsQueue?.shift() ?? null;
        const executionId = e.executionId ?? `exec_${randomUUID()}`;
        const outcome = e.outcome === "failed" ? "failed" : "succeeded";
        const recoveredExecutionIds = e.recoveredExecutionIds ?? [];
        agentEventStore.markRecovered(id, recoveredExecutionIds, executionId);
        bus.emit({
          type: "agent_tool_result", caseId: id, runId, executionId, tool: e.name ?? "",
          content: e.content, outcome, recoveredExecutionIds, failureDiagnostic: e.failureDiagnostic ?? null, refs,
        });
        agentEventStore.append(
          id, "tool_result", `${e.name} → ${e.content}`, e.name ?? undefined, undefined, refs ?? undefined,
          { runId, executionId, outcome, failureDiagnostic: e.failureDiagnostic },
        );
        trajectory.push(`[result] ${e.name} → ${e.content}`);
      }
      else if (e.type === "tool_blocked") {
        bus.emit({
          type: "agent_tool_blocked",
          caseId: id,
          runId,
          tool: e.name ?? "",
          input: e.input ?? e.content ?? "",
          reason: "identical call already failed in this run",
        });
      }
      else if (e.type === "tool_advisory") {
        const content = `Exploration advisory for ${e.name ?? "tool"}:\n${e.content}`;
        bus.emit({ type: "agent_text", caseId: id, content });
        agentEventStore.append(id, "text", content, e.name ?? undefined);
        trajectory.push(`[advisory] ${content}`);
      }
      else if (e.type === "text") { bus.emit({ type: "agent_text", caseId: id, content: e.content }); agentEventStore.append(id, "text", e.content); trajectory.push(`[text] ${e.content}`); }
      else if (e.type === "reasoning") {
        bus.emit({ type: "agent_reasoning", caseId: id, content: e.content });
        agentEventStore.append(id, "reasoning", e.content);
        trajectory.push(`[reasoning] ${e.content}`);
      }
      else if (e.type === "done") { bus.emit({ type: "agent_done", caseId: id, content: e.content }); agentEventStore.append(id, "done", e.content); trajectory.push(`[done] ${e.content}`); }
      else if (e.type === "budget_warning") {
        const content = `运行预算提醒：${e.content}`;
        bus.emit({ type: "agent_text", caseId: id, content });
        agentEventStore.append(id, "text", content);
        trajectory.push(`[budget_warning] ${e.content}`);
      }
      else if (e.type === "budget_exhausted") {
        const run = runs.needsContinuation(runId, e.content);
        if (run) {
          emitReleasedValidationLeases(id, runId, `Run needs continuation: ${e.content}`);
          agentEventStore.append(id, "done", "Agent 已到达本次运行预算，需要继续运行。");
          bus.emit({ type: "agent_run_needs_continuation", run, reason: e.content });
          trajectory.push(`[budget_exhausted] ${e.content}`);
        }
      }
      else if (e.type === "stream_start") bus.emit({ type: "agent_stream_start", caseId: id, runId, messageId: e.messageId ?? "" });
      else if (e.type === "stream_delta") bus.emit({ type: "agent_stream_delta", caseId: id, runId, messageId: e.messageId ?? "", delta: e.content });
      else if (e.type === "stream_end") bus.emit({ type: "agent_stream_end", caseId: id, runId, messageId: e.messageId ?? "", content: e.content });
      else if (e.type === "retrying") {
        bus.emit({
          type: "agent_retrying",
          caseId: id,
          runId,
          attempt: e.attempt ?? 1,
          maxAttempts: e.maxAttempts ?? 1,
          reason: e.content,
        });
      }
      else if (e.type === "usage") {
        recordRunUsage("agent", {
          promptTokens: e.promptTokens ?? 0,
          completionTokens: e.completionTokens ?? 0,
          totalTokens: e.totalTokens ?? 0,
        });
      }
      else if (e.type === "interrupted") {
        const interrupted = runs.markInterrupted(runId, running.run.interruptReason ?? e.content);
        if (interrupted) {
          emitReleasedValidationLeases(id, runId, `Run interrupted: ${interrupted.interruptReason ?? e.content}`);
          bus.emit({ type: "agent_run_interrupted", run: interrupted });
        }
      }
    }, {
      signal: running.abortController.signal,
      runId,
      budget,
      shouldReviewAtCheckpoint: (turnCount) => observerCadence.shouldReview(
        turnCount,
        observerCadenceSnapshot(observerStore.listByCase(id).warnings.filter((warning) =>
          warning.relatedRunId === runId)),
      ),
      getObserverReviewTrigger: () => observerScheduler.consume(),
      getSteeringMessages: () => runs.consumeSteering(runId),
      getRuntimeMessages: () => runs.consumeRuntimeMessages(runId),
      onTurnComplete: async (summary) => runObserverReview(
        summary.runId,
        summary.trajectory,
        summary.trigger,
        summary.turnCount,
      ),
      failureMemory,
      getExecutionScopeKey: () => {
        const runningTask = taskStore.listByCase(id).find((task) => task.runId === runId && task.status === "running");
        return runningTask ? `task:${runningTask.id}` : `run:${runId}:exploration`;
      },
      onAuthorizeToolExecute: (call) => {
        const actionableTasks = taskStore.listByCase(id).filter((task) =>
          task.runId === runId && ["open", "approved", "running", "recheck_candidate"].includes(task.status));
        const runningTasks = actionableTasks.filter((task) => task.status === "running");
        const decision = structurePolicy.authorize(call.name, actionableTasks.length, runningTasks.length);
        if (decision) return decision;
        const runningTask = runningTasks[0];
        if (
          structurePolicy.requiresStructuredTask(call.name)
          && runningTask
          && (runningTask.hypothesisIds?.length ?? 0) === 0
        ) {
          return `Running task ${runningTask.id} is not linked to a hypothesis. Link it before executing more active investigation tools.`;
        }
        return undefined;
      },
      onBeforeToolExecute: (call) => {
        const windowStack = toolRefWindows.get(call.name) ?? [];
        windowStack.push(runTimelineEntries.length);
        toolRefWindows.set(call.name, windowStack);
        validationOutcomeBefore = executingValidationTask ? captureValidationOutcome() : undefined;
        const serialized = JSON.stringify(call.input);
        const referencedKnowledge = [...availableKnowledge.values()].filter((ref) => serialized.includes(ref.id));
        const alternatives = [
          latestSharedKnowledge?.attackPaths[0],
          latestSharedKnowledge?.verifiedFindings[0],
          latestSharedKnowledge?.identities[0],
        ].filter((item): item is string => Boolean(item));
        return buildExplorationAdvisory({
          tool: call.name,
          input: call.input,
          referencedKnowledge,
          usageScores: knowledgeUsageStore.scores(id, runId),
          alternatives,
        });
      },
      onToolExecuted: (report) => {
        structurePolicy.observe(report);
        const browserAction = report.meta?.browserAction as {
          id?: unknown;
          kind?: unknown;
          controller?: unknown;
          beforeUrl?: unknown;
          afterUrl?: unknown;
          trafficIds?: unknown;
          startedAt?: unknown;
          completedAt?: unknown;
        } | undefined;
        const browserTrafficIds = Array.isArray(browserAction?.trafficIds)
          ? browserAction.trafficIds.filter((id): id is string => typeof id === "string")
          : [];
        if (typeof browserAction?.id === "string") {
          const actionEntry = timelineStore.append(
            id,
            "browser_action_completed",
            JSON.stringify({
              actionId: browserAction.id,
              kind: browserAction.kind,
              controller: browserAction.controller,
              beforeUrl: browserAction.beforeUrl,
              afterUrl: browserAction.afterUrl,
              outcome: report.ok ? "succeeded" : "failed",
              trafficIds: browserTrafficIds,
              startedAt: browserAction.startedAt,
              completedAt: browserAction.completedAt,
            }),
            browserAction.id,
            runId,
          );
          bus.emit({ type: "timeline_appended", entry: actionEntry });
        }
        const windowStack = toolRefWindows.get(report.name) ?? [];
        const windowStart = windowStack.shift() ?? runTimelineEntries.length;
        const refsQueue = pendingToolRefs.get(report.name) ?? [];
        const collectedRefs = collectToolRefs(runTimelineEntries.slice(windowStart));
        const toolRefs = collectedRefs || browserTrafficIds.length
          ? {
              factIds: collectedRefs?.factIds ?? [],
              taskIds: collectedRefs?.taskIds ?? [],
              trafficIds: [...new Set([...(collectedRefs?.trafficIds ?? []), ...browserTrafficIds])],
              timelineEntryIds: collectedRefs?.timelineEntryIds ?? [],
            }
          : null;
        refsQueue.push(toolRefs);
        pendingToolRefs.set(report.name, refsQueue);
        correctionAttribution.observe({
          tool: report.name,
          args: report.input,
          ok: report.ok,
          refs: toolRefs,
        });
        if (executingTaskId && !["record_task", "manage_validation_task"].includes(report.name)) {
          const taskEntry = timelineStore.append(
            id,
            "task_tool_result",
            `Task=${executingTaskId}; tool=${report.name}; outcome=${report.ok ? "ok" : "failed"}`,
            executingTaskId,
            runId,
          );
          bus.emit({ type: "timeline_appended", entry: taskEntry });
        }
        if (executingValidationTask && validationOutcomeBefore && !["record_task", "manage_validation_task"].includes(report.name)) {
          const observation = observeValidationOutcome({
            ...executingValidationTask,
            tool: report.name,
            ok: report.ok,
            before: validationOutcomeBefore,
            after: captureValidationOutcome(),
          });
          validationFeedback = appendValidationFeedback(validationFeedback, observation);
          const feedbackEntry = timelineStore.append(
            id,
            "validation_feedback_recorded",
            JSON.stringify(observation),
            executingValidationTask.taskId,
            runId,
          );
          bus.emit({ type: "timeline_appended", entry: feedbackEntry });
        }
        validationOutcomeBefore = undefined;
        if (report.ok && ["record_task", "manage_validation_task"].includes(report.name)) {
          const reportInput = report.input as Record<string, unknown>;
          const candidateTaskId = report.name === "manage_validation_task" ? reportInput.taskId : reportInput.id;
          const taskId = typeof candidateTaskId === "string" ? candidateTaskId : undefined;
          const task = taskId ? taskStore.getById(taskId) : undefined;
          const findingId = task && isConsensusValidationTask(task) ? validationFindingId(task) : undefined;
          if (task?.status === "running") {
            executingTaskId = task.id;
          } else if (taskId && executingTaskId === taskId) {
            executingTaskId = undefined;
          }
          if (task && findingId && task.status === "running") {
            executingValidationTask = { taskId: task.id, findingId };
          } else if (taskId && executingValidationTask?.taskId === taskId) {
            executingValidationTask = undefined;
          }
        }
        const referencedKnowledge = knowledgeUsageStore.markReferenced(
          id,
          runId,
          report.input,
          [...availableKnowledge.values()],
        );
        if (referencedKnowledge.length) {
          const detail = `Tool=${report.name}; knowledge=${referencedKnowledge.map((ref) => `${ref.kind}:${ref.id}`).join(",")}`;
          const entry = timelineStore.append(id, "knowledge_used", detail, referencedKnowledge[0].id, runId);
          bus.emit({ type: "timeline_appended", entry });
        }
        const evidenceConsumption = evidenceConsumptionTracker.observe(report);
        if (evidenceConsumption.type === "consumed") {
          const directlyReferenced = new Set(referencedKnowledge.map((ref) => `${ref.kind}:${ref.id}`));
          const implicitlyUsed = evidenceConsumption.refs.filter((ref) =>
            !directlyReferenced.has(`${ref.kind}:${ref.id}`));
          knowledgeUsageStore.markUsed(id, runId, implicitlyUsed);
          const detail = [
            `Task=${evidenceConsumption.taskId}`,
            `tool=${evidenceConsumption.tool}`,
            `facts=${evidenceConsumption.refs.map((ref) => ref.id).join(",")}`,
          ].join("; ");
          const entry = timelineStore.append(
            id,
            "evidence_consumed",
            detail,
            evidenceConsumption.taskId,
            runId,
          );
          bus.emit({ type: "timeline_appended", entry });
          emitArtifactConsumptionSnapshot(id);
        } else if (evidenceConsumption.type === "replan") {
          const factIds = evidenceConsumption.refs.map((ref) => ref.id);
          const message = [
            `Current Task ${evidenceConsumption.taskId} received new evidence Facts, but the next ${evidenceConsumption.missedActions} successful active actions did not reference them.`,
            `Before another active action, inspect ${factIds.join(", ")} with get_fact_detail and decide whether the evidence closes the current gap or is irrelevant under a stated reason.`,
            "Do not switch to another queued Task solely because this reminder was issued.",
          ].join("\n");
          runs.addRuntimeMessage(runId, message);
          const entry = timelineStore.append(
            id,
            "evidence_consumption_replan_requested",
            `Task=${evidenceConsumption.taskId}; facts=${factIds.join(",")}; missedActions=${evidenceConsumption.missedActions}`,
            evidenceConsumption.taskId,
            runId,
          );
          bus.emit({ type: "timeline_appended", entry });
          emitArtifactConsumptionSnapshot(id);
        } else if (evidenceConsumption.type === "closed") {
          const entry = timelineStore.append(
            id,
            "evidence_consumption_tracking_closed",
            `Task=${evidenceConsumption.taskId}`,
            evidenceConsumption.taskId,
            runId,
          );
          bus.emit({ type: "timeline_appended", entry });
          emitArtifactConsumptionSnapshot(id);
        }
        const outcomeKnowledge = new Map(referencedKnowledge.map((ref) => [`${ref.kind}:${ref.id}`, ref]));
        if (evidenceConsumption.type === "consumed") {
          for (const ref of evidenceConsumption.refs) outcomeKnowledge.set(`${ref.kind}:${ref.id}`, ref);
        }
        const settledKnowledge = knowledgeOutcomeTracker.settle(report, [...outcomeKnowledge.values()]);
        if (settledKnowledge.refs.length) {
          knowledgeUsageStore.recordOutcome(
            id,
            runId,
            settledKnowledge.refs,
            settledKnowledge.outcome.positive,
            settledKnowledge.outcome.negative,
          );
          const detail = [
            `Tool=${report.name}`,
            `outcome=${settledKnowledge.outcome.reason}`,
            `score=+${settledKnowledge.outcome.positive}/-${settledKnowledge.outcome.negative}`,
            `knowledge=${settledKnowledge.refs.map((ref) => `${ref.kind}:${ref.id}`).join(",")}`,
          ].join("; ");
          const entry = timelineStore.append(id, "knowledge_outcome", detail, settledKnowledge.refs[0].id, runId);
          bus.emit({ type: "timeline_appended", entry });
        }
        observerScheduler.observe(report);
        if (report.ok) {
          validationExplorationState = advanceExplorationBoundary(validationExplorationState);
          syncValidationRuntime();
        }
        const replanTriggers = new Set([
          "record_fact",
          "record_hypothesis",
          "resolve_hypothesis",
          "record_task",
          "manage_validation_task",
          "record_identity",
        "compare_identity_traffic",
          "record_attack_path",
          "record_validation_conclusion",
          "propose_scope_expansion",
          "manage_artifact_limitation",
          "authorize_artifact_retry",
          "manage_artifact_recovery",
        ]);
        if (report.ok && replanTriggers.has(report.name)) {
          try {
            hypothesisFeedback.reconcile(id, runId, summarizeValidationFeedbackHistory(validationFeedback));
            const rebalanced = hypothesisScheduler.rebalance(id, runId);
            sessionStore.upsert(id, { activeHypothesisIds: rebalanced.active.map((item) => item.id) }, runId);
            const activeSummary = rebalanced.active
              .map((item) => `${item.id}(${item.priorityScore ?? 0})`)
              .join(", ") || "none";
            const pathPlan = getAttackPathPlan();
            const evidenceGapPlan = getEvidenceGapPlan();
            const validationMatrixPlan = getValidationMatrixPlan();
            const rerankedTasks = rankValidationTasks({
              tasks: taskStore.listByCase(id).filter((task) =>
                task.runId === runId && ["open", "blocked", "running", "recheck_candidate"].includes(task.status)),
              facts: factStore.listByCase(id),
              consensus: validationConsensusStore.listByCase(id),
              paths: attackPathStore.listByCase(id),
              feedback: summarizeValidationFeedbackHistory(validationFeedback),
            });
            const priorityShift = decideValidationPriorityShift({
              previous: currentValidationPriority,
              ranked: rerankedTasks,
            });
            let explorationWindowTaskId = validationExplorationState.explorationBoundariesRemaining > 0
              ? rerankedTasks.find((item) => !item.validation)?.task.id
              : undefined;
            const explorationDecision = priorityShift.shifted
              ? applyValidationExplorationPolicy({ state: validationExplorationState, shift: priorityShift, ranked: rerankedTasks })
              : undefined;
            if (explorationDecision) validationExplorationState = explorationDecision.state;
            if (priorityShift.shifted && priorityShift.next && explorationDecision?.allowValidationShift && !executingTaskId) {
              const prioritized = rerankedTasks.find((item) => item.task.id === priorityShift.next?.taskId);
              const priorityEntry = timelineStore.append(
                id,
                "validation_priority_shifted",
                `Trigger=${report.name}; reason=${priorityShift.reason}; policy=${explorationDecision.reason}; previous=${priorityShift.previous?.taskId ?? "none"}:${priorityShift.previous?.score ?? 0}; next=${priorityShift.next.taskId}:${priorityShift.next.score}; factors=${prioritized?.reasons.join(", ") ?? "none"}`,
                priorityShift.next.taskId,
                runId,
              );
              bus.emit({ type: "timeline_appended", entry: priorityEntry });
              runs.addSteering(runId, [
                "[Validation priority shift]",
                `At the completed tool boundary, validation task ${priorityShift.next.taskId} became the clear priority (${priorityShift.next.score}).`,
                `Reason: ${priorityShift.reason}; factors: ${prioritized?.reasons.join(", ") ?? "none"}.`,
                "Do not interrupt or repeat the tool that just completed. At the next decision point, finish recording its evidence, then switch only if the new task remains actionable.",
              ].join("\n"));
              currentValidationPriority = priorityShift.next;
            } else if (priorityShift.shifted && executingTaskId) {
              const queuedEntry = timelineStore.append(
                id,
                "validation_priority_queued",
                `Current=${executingTaskId}; queued=${priorityShift.next?.taskId ?? "none"}; reason=${priorityShift.reason}`,
                priorityShift.next?.taskId,
                runId,
              );
              bus.emit({ type: "timeline_appended", entry: queuedEntry });
            } else if (priorityShift.shifted && explorationDecision && !explorationDecision.allowValidationShift) {
              explorationWindowTaskId = explorationDecision.explorationTaskId;
              if (explorationDecision.notifyExplorationWindow && explorationWindowTaskId) {
                const explorationTask = rerankedTasks.find((item) => item.task.id === explorationWindowTaskId)?.task;
                const deferredEntry = timelineStore.append(
                  id,
                  "validation_priority_deferred",
                  `Trigger=${report.name}; validation=${priorityShift.next?.taskId ?? "none"}; exploration=${explorationWindowTaskId}; boundaries=${validationExplorationState.explorationBoundariesRemaining}`,
                  explorationWindowTaskId,
                  runId,
                );
                bus.emit({ type: "timeline_appended", entry: deferredEntry });
                runs.addSteering(runId, [
                  "[Exploration window]",
                  `Validation switching is temporarily deferred after repeated validation preemption. Preserve up to ${validationExplorationState.explorationBoundariesRemaining} completed tool boundaries for exploration task ${explorationWindowTaskId}: ${explorationTask?.title ?? "open exploration"}.`,
                  "Use this as an opportunity, not a forced tool call. Record any useful evidence or hypothesis; Critical findings and validated attack paths may still preempt immediately.",
                ].join("\n"));
              }
            } else if (currentValidationPriority) {
              const retained = rerankedTasks.find((item) => item.task.id === currentValidationPriority?.taskId);
              currentValidationPriority = retained
                ? { taskId: retained.task.id, score: retained.score }
                : undefined;
            }
            syncValidationRuntime();
            const entry = timelineStore.append(
              id,
              "investigation_replan_requested",
              `Trigger=${report.name}; active hypotheses=${activeSummary}; ${pathPlan.replace(/\n/g, " | ")}; ${evidenceGapPlan.replace(/\n/g, " | ")}; ${validationMatrixPlan.replace(/\n/g, " | ")}`,
              undefined,
              runId,
            );
            bus.emit({ type: "timeline_appended", entry });
            runs.addSteering(runId, [
              "[Investigation replan]",
              `Important state changed after ${report.name}.`,
              `Active hypotheses by priority: ${activeSummary}.`,
              pathPlan,
              evidenceGapPlan,
              validationMatrixPlan,
              explorationWindowTaskId
                ? `Preserve the active exploration window for task ${explorationWindowTaskId}; do not switch to routine validation yet.`
                : "Re-evaluate the current task against both the ranked hypotheses and path breakpoints. Continue when it advances a leading breakpoint; otherwise explain the evidence-backed pivot before selecting the next verification task.",
            ].join("\n"));
          } catch (error) {
            const entry = timelineStore.append(
              id,
              "investigation_replan_failed",
              `Trigger=${report.name}; error=${(error as Error).message}`,
              undefined,
              runId,
            );
            bus.emit({ type: "timeline_appended", entry });
          }
          return;
        }
        // Execution failures are already persisted as scoped agent events with
        // diagnostics. They are not observations and must never become Facts.
      },
    }).finally(() => {
      offTimelineCollect();
      if (activeToolRegistries.get(id)?.runId === runId) activeToolRegistries.delete(id);
    });

    const afterRun = runs.get(runId)?.run;
    if (afterRun && afterRun.status === "running") {
      const completed = runs.complete(runId, trajectory.at(-1) ?? "completed");
      if (completed) {
        emitReleasedValidationLeases(id, runId, `Run completed: ${completed.completionReason ?? "completed"}`);
        bus.emit({ type: "agent_run_completed", run: completed, content: trajectory.at(-1) ?? "" });
      }
    }

    timelineStore.append(id, "context_built", `Injected ${built.injectedFactIds.length} facts, ~${built.estimatedTokens} tokens, degraded:${built.degraded.join(",") || "none"}`);

    // 增量远期摘要：run 结束后按当前模型上下文预算压缩远期对话，失败不影响已完成的 run
    try {
      const allEvents = agentEventStore.listByCase(id);
      if (allEvents.length > contextBudget.recentWindow) {
        // 已摘要到第几条（用事件总数做游标，避免依赖 schema seq 字段）
        const alreadyCovered = contextSummaryStore.latest(id)?.coversUpToEventSeq ?? 0;
        // 远期窗口：[alreadyCovered, allEvents.length - recentWindow)
        const farEndIdx = allEvents.length - contextBudget.recentWindow;
        if (farEndIdx > alreadyCovered) {
          const farEvents = allEvents.slice(alreadyCovered, farEndIdx);
          const convoText = farEvents
            .filter((e) => ["user", "done", "tool_call", "tool_result", "validation", "error"].includes(e.kind))
            .map((e) => {
              const text = e.text.length > 1_200 ? `${e.text.slice(0, 1_200)}…` : e.text;
              return `${e.kind}${e.tool ? `(${e.tool})` : ""}: ${text}`;
            })
            .join("\n");
          const farHistoryTokens = estimateTokens(convoText);
          if (
            convoText.trim()
            && (
              farEvents.length >= contextBudget.recentWindow
              || shouldCompressFarHistory({ farHistoryTokens, budget: contextBudget })
            )
          ) {
            const doneTaskLines = taskStore.listByCase(id)
              .filter((t) => t.status === "done")
              .map((t) => `${t.title}：${t.reason || "完成"}`);
            const summary = await compressFar({ convoText, doneTaskLines }, llm);
            contextSummaryStore.append(id, farEndIdx, summary);
          }
        }
      }
    } catch (e) {
      console.error("[compressor]", (e as Error).message);
    }

    };

    bus.emit({ type: "agent_run_started", run: active.run });
    bus.emit({ type: "agent_started", caseId: id, goal: active.run.goal });
    setImmediate(() => {
      void runAgentInBackground(active.run.id).catch((err) => {
        if (activeToolRegistries.get(id)?.runId === active.run.id) activeToolRegistries.delete(id);
        const current = runs.get(active.run.id);
        if (current?.run.status === "interrupting") {
          const interrupted = runs.markInterrupted(active.run.id, current.run.interruptReason ?? (err as Error).message);
          if (interrupted) {
            emitReleasedValidationLeases(id, active.run.id, `Run interrupted: ${interrupted.interruptReason ?? (err as Error).message}`);
            bus.emit({ type: "agent_run_interrupted", run: interrupted });
          }
        } else {
          const failed = runs.fail(active.run.id, (err as Error).message);
          if (failed) {
          emitReleasedValidationLeases(id, active.run.id, `Run failed: ${(err as Error).message}`);
          bus.emit({ type: "agent_run_failed", run: failed, error: (err as Error).message });
          bus.emit({ type: "agent_error", caseId: id, content: (err as Error).message });
          agentEventStore.append(id, "error", (err as Error).message);
          }
        }
      });
    });
    return { run: active.run };
  });

  app.post("/api/agent/runs/:runId/steer", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content?.trim()) return reply.code(400).send({ error: "content required" });
    const run = runs.addSteering(runId, content.trim());
    if (!run) return reply.code(404).send({ error: "run not found or not active" });
    agentEventStore.append(run.caseId, "user", `[steering] ${content.trim()}`);
    bus.emit({ type: "agent_steering_added", caseId: run.caseId, runId, content: content.trim() });
    return { run };
  });

  app.post("/api/agent/runs/:runId/interrupt", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    const run = runs.interrupt(runId, reason);
    if (!run) return reply.code(404).send({ error: "run not found" });
    emitReleasedValidationLeases(run.caseId, runId, `Run interruption requested: ${reason ?? "user interrupted"}`);
    const pendingApproval = pendingInterventions.get(run.caseId).approval;
    if (pendingApproval) pendingInterventions.clearApproval(run.caseId, pendingApproval.approvalId);
    return { run };
  });

  app.get("/api/cases/:id/agent/runs/active", async (req) => {
    const { id } = req.params as { id: string };
    return runs.getActiveByCase(id)?.run ?? null;
  });

  app.get("/api/cases/:id/agent/runs/latest", async (req) => {
    const { id } = req.params as { id: string };
    return runs.getLatestByCase(id)?.run ?? null;
  });

  app.get("/api/agent/runs/:runId/usage", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (!runs.get(runId)) return reply.code(404).send({ error: "run not found" });
    return runs.getUsage(runId);
  });

  app.post("/api/agent/approvals/:approvalId", async (req, reply) => {
    const { approvalId } = req.params as { approvalId: string };
    const { decision } = req.body as { decision: "approved" | "rejected" };
    const ok = approvals.resolve(approvalId, decision);
    if (!ok) return reply.code(404).send({ error: "approval not found" });
    return { ok: true };
  });
}

function factSeverity(fact: Fact): keyof CaseSummary["severityCounts"] {
  const value = fact.value as Record<string, unknown>;
  const candidate = String(value.severity ?? fact.tags.find((tag) => /^(critical|high|medium|low|info)$/i.test(tag)) ?? "info").toLowerCase();
  return candidate === "critical" || candidate === "high" || candidate === "medium" || candidate === "low" ? candidate : "info";
}

function isSecurityFinding(fact: Fact): boolean {
  const value = fact.value as Record<string, unknown>;
  return /finding|vulnerab|exposure|secret|credential/i.test(fact.type) || typeof value.severity === "string" || fact.tags.some((tag) => /^(critical|high|medium|low)$/i.test(tag));
}
