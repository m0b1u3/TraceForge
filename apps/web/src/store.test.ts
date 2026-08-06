import { describe, it, expect, beforeEach } from "vitest";
import type { ValidationWorkflowSnapshot } from "@traceforge/shared";
import { CLIENT_AGENT_EVENT_LIMIT, diffValidationWorkflow, mergeValidationWorkflow, observerTelemetryFromHistory, takeRecent, useStore } from "./store.js";

function resetStore() {
  useStore.setState({
    caseId: "case_1",
    cases: [{ id: "case_1", name: "Case 1", status: "active", scopeRules: [], createdAt: "now" }],
    traffic: [{ id: "traffic_1", caseId: "case_1", url: "https://t.com", method: "GET", requestHeaders: {}, requestBody: null, responseStatus: 200, responseBody: null, createdAt: "now" }],
    identities: [],
    attackPaths: [],
    securityReports: [],
    facts: [],
    artifacts: [],
    artifactAnalyzerCapabilities: {},
    artifactConsumptions: [],
    artifactAnalysisAttempts: [],
    artifactLimitations: [],
    hypotheses: [],
    tasks: [],
    timeline: [],
    actions: [],
    decisions: [],
    pendingConfirmation: null,
    knowledgeDialog: null,
    agentEvents: [],
    activeRun: null,
    continuationRun: null,
    agentBusy: false,
    streamingMessages: {},
    streamedAgentTexts: [],
    toast: null,
    warnings: [],
    observerStrategyAudits: [],
    observerTelemetry: {
      reviewCount: 0,
      correctionCount: 0,
      correctionResolvedCount: 0,
      correctionFailedCount: 0,
      failureCount: 0,
      totalTokens: 0,
      lastTrigger: null,
      lastDurationMs: null,
    },
    validationWorkflow: null,
    validationWorkflowDelta: null,
    validationSyncStatus: "stale",
    knowledgeTarget: null,
    workspacePanelRequest: null,
    pendingApproval: null,
    pendingScope: null,
    browserController: null,
    browserUrl: "",
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    tokenUsageHistory: [],
    connectionStatus: "offline",
  });
}

describe("validation workflow realtime state", () => {
  beforeEach(() => resetStore());

  it("accepts a workflow snapshot for the active case and ignores another case", () => {
    const snapshot = {
      caseId: "case_1", runId: "run_1", revision: 1, generatedAt: "now", runningLease: null, leader: null,
      exploration: { consecutiveValidationShifts: 0, explorationBoundariesRemaining: 0 }, items: [], auditIssues: [],
    };
    useStore.getState().handleRuntimeEvent({ type: "validation_workflow_updated", snapshot: { ...snapshot, caseId: "case_2" } });
    expect(useStore.getState().validationWorkflow).toBeNull();
    useStore.getState().handleRuntimeEvent({ type: "validation_workflow_updated", snapshot });
    expect(useStore.getState().validationWorkflow).toEqual(snapshot);
  });

  it("rejects an older recovery snapshot after a newer realtime event", () => {
    const base = {
      caseId: "case_1", runId: "run_1", generatedAt: "2026-07-21T00:00:00.000Z", runningLease: null, leader: null,
      exploration: { consecutiveValidationShifts: 0, explorationBoundariesRemaining: 0 }, items: [], auditIssues: [],
    };
    const realtime = { ...base, revision: 8, runningLease: "task-live" };
    const delayedRecovery = { ...base, revision: 7, generatedAt: "2026-07-21T00:00:01.000Z" };
    expect(mergeValidationWorkflow(realtime, delayedRecovery)).toBe(realtime);
  });

  it("describes only findings and control state that actually changed", () => {
    const item = {
      findingId: "finding_1", findingTitle: "SQL injection", findingStatus: "candidate", consensusStatus: "insufficient",
      confidence: 0.6, taskId: "task_1", taskStatus: "open" as const, priorityScore: 70, priorityReasons: [], completionReady: false,
      missingEvidence: ["reproduction"], feedback: null,
    };
    const previous: ValidationWorkflowSnapshot = {
      caseId: "case_1", runId: "run_1", revision: 1, generatedAt: "a", runningLease: null, leader: null,
      exploration: { consecutiveValidationShifts: 0, explorationBoundariesRemaining: 0 }, items: [item], auditIssues: [],
    };
    const next: ValidationWorkflowSnapshot = {
      ...previous, revision: 2, generatedAt: "b", runningLease: "task_1", leader: { taskId: "task_1", score: 82 },
      items: [{ ...item, consensusStatus: "verified", confidence: 0.93, completionReady: true, missingEvidence: [] }],
    };
    const delta = diffValidationWorkflow(previous, next);
    expect(delta).toEqual(expect.objectContaining({ changedFindingIds: ["finding_1"], leaseChanged: true, leaderChanged: true }));
    expect(delta?.summary.join(" ")).toContain("SQL injection: insufficient → verified");
  });

  it("adds only selected validation timeline events to the live Agent console", () => {
    const entry = { id: "timeline_1", caseId: "case_1", runId: "run_1", refId: "task_1", createdAt: "now" };
    useStore.getState().handleRuntimeEvent({ type: "timeline_appended", entry: { ...entry, eventType: "validation_task_claimed", detail: "Task=task_1; consensus=insufficient" } });
    useStore.getState().handleRuntimeEvent({ type: "timeline_appended", entry: { ...entry, id: "timeline_2", eventType: "validation_feedback_recorded", detail: "{}" } });
    expect(useStore.getState().agentEvents).toEqual([expect.objectContaining({ kind: "validation", text: "Task=task_1; consensus=insufficient", tool: "validation_task_claimed", createdAt: "now" })]);
  });

  it("keeps refs from live tool result events for console to graph linking", () => {
    const refs = { factIds: ["fact_1"], taskIds: [], timelineEntryIds: ["tl_1"] };
    useStore.getState().handleRuntimeEvent({ type: "agent_tool_result", caseId: "case_1", runId: "run_1", executionId: "exec_1", tool: "record_fact", content: "ok", outcome: "succeeded", recoveredExecutionIds: [], refs });
    useStore.getState().handleRuntimeEvent({ type: "agent_tool_result", caseId: "case_1", runId: "run_1", executionId: "exec_2", tool: "get_traffic", content: "[]", outcome: "succeeded", recoveredExecutionIds: [] });
    const events = useStore.getState().agentEvents;
    expect(events[0]).toEqual(expect.objectContaining({ kind: "tool_result", refs }));
    expect(events[1]).toEqual(expect.objectContaining({ kind: "tool_result", refs: null }));
  });

  it("applies server recovery updates to an earlier live execution", () => {
    useStore.getState().handleRuntimeEvent({ type: "agent_tool_call", caseId: "case_1", runId: "run_1", executionId: "exec_1", tool: "exec_command", input: "{\"command\":\"first\"}" });
    useStore.getState().handleRuntimeEvent({ type: "agent_tool_result", caseId: "case_1", runId: "run_1", executionId: "exec_1", tool: "exec_command", content: "exit=1", outcome: "failed", recoveredExecutionIds: [] });
    useStore.getState().handleRuntimeEvent({ type: "agent_tool_call", caseId: "case_1", runId: "run_1", executionId: "exec_2", tool: "exec_command", input: "{\"command\":\"second\"}" });
    useStore.getState().handleRuntimeEvent({ type: "agent_tool_result", caseId: "case_1", runId: "run_1", executionId: "exec_2", tool: "exec_command", content: "exit=0", outcome: "succeeded", recoveredExecutionIds: ["exec_1"] });

    const events = useStore.getState().agentEvents;
    expect(events.filter((event) => event.executionId === "exec_1")).toEqual([
      expect.objectContaining({ outcome: "recovered", recoveredByExecutionId: "exec_2" }),
      expect.objectContaining({ outcome: "recovered", recoveredByExecutionId: "exec_2" }),
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({ executionId: "exec_2", outcome: "succeeded" }));
  });

  it("uses one knowledge navigation action for panel requests, inspector cleanup, and stale targets", () => {
    useStore.setState({
      tasks: [{ id: "task_1", caseId: "case_1", title: "Validate IDOR", status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "high", createdAt: "now", updatedAt: "now", updateCount: 0 }],
      selectedFactId: "fact_old",
      inspectorMode: "finding",
    });
    useStore.getState().navigateToKnowledge({ kind: "task", id: "task_1" });
    expect(useStore.getState()).toEqual(expect.objectContaining({
      selectedTaskId: "task_1",
      selectedFactId: null,
      inspectorMode: "task",
      knowledgeTarget: expect.objectContaining({ kind: "task", id: "task_1" }),
      workspacePanelRequest: expect.objectContaining({ panel: "knowledge" }),
    }));

    useStore.getState().navigateToKnowledge({ kind: "task", id: "task_deleted" });
    expect(useStore.getState().toast?.message).toBe("Related task is no longer available.");
  });
});

describe("artifact consumption realtime state", () => {
  beforeEach(() => resetStore());

  it("replaces the active case snapshot and ignores snapshots from another case", () => {
    const consumption = {
      caseId: "case_1",
      runId: "run_1",
      artifactId: "artifact_1",
      taskId: "task_1",
      factIds: ["fact_1"],
      status: "consumed" as const,
      usedByTool: "record_fact",
      missedActions: 0,
      updatedAt: "now",
      lastEventId: "timeline_1",
    };

    useStore.getState().handleRuntimeEvent({
      type: "artifact_consumption_snapshot",
      caseId: "case_2",
      consumptions: [{ ...consumption, caseId: "case_2" }],
    });
    expect(useStore.getState().artifactConsumptions).toEqual([]);

    useStore.getState().handleRuntimeEvent({
      type: "artifact_consumption_snapshot",
      caseId: "case_1",
      consumptions: [consumption],
    });
    expect(useStore.getState().artifactConsumptions).toEqual([consumption]);
  });
});

describe("artifact analysis attempt realtime state", () => {
  beforeEach(() => resetStore());

  it("inserts and then updates one persistent analysis attempt", () => {
    const attempt = {
      id: "attempt_1",
      caseId: "case_1",
      runId: "run_1",
      artifactId: "artifact_1",
      analyzerId: "structured-analyzer",
      status: "running" as const,
      coverageDimensions: ["metadata"] as const,
      error: null,
      analysis: null,
      startedAt: "now",
      finishedAt: null,
    };
    useStore.getState().handleRuntimeEvent({ type: "artifact_analysis_attempt_updated", attempt: { ...attempt, coverageDimensions: [...attempt.coverageDimensions] } });
    useStore.getState().handleRuntimeEvent({
      type: "artifact_analysis_attempt_updated",
      attempt: { ...attempt, coverageDimensions: [...attempt.coverageDimensions], status: "failed", error: "Analyzer exited.", finishedAt: "later" },
    });

    expect(useStore.getState().artifactAnalysisAttempts).toEqual([
      expect.objectContaining({ id: "attempt_1", status: "failed", error: "Analyzer exited." }),
    ]);
  });
});

describe("artifact limitation realtime state", () => {
  beforeEach(() => resetStore());

  it("inserts and updates an auditable limitation disposition", () => {
    const disposition = {
      id: "artifact_limitation_1",
      caseId: "case_1",
      runId: "run_1",
      taskId: "task_1",
      artifactId: "artifact_1",
      status: "accepted" as const,
      missingDimensions: ["text"] as const,
      attemptIds: ["attempt_1"],
      rationale: "All currently compatible analyzer paths are exhausted.",
      prohibitedConclusion: "This limitation does not prove content absence and cannot verify or reject a security finding." as const,
      createdAt: "now",
      updatedAt: "now",
    };
    useStore.getState().handleRuntimeEvent({
      type: "artifact_limitation_updated",
      disposition: { ...disposition, missingDimensions: [...disposition.missingDimensions] },
    });
    useStore.getState().handleRuntimeEvent({
      type: "artifact_limitation_updated",
      disposition: { ...disposition, missingDimensions: [...disposition.missingDimensions], status: "revoked", updatedAt: "later" },
    });

    expect(useStore.getState().artifactLimitations).toEqual([
      expect.objectContaining({ id: "artifact_limitation_1", status: "revoked", updatedAt: "later" }),
    ]);
  });
});

describe("store security reports", () => {
  beforeEach(() => resetStore());

  it("upserts persisted report runtime events for the active case", () => {
    const report = {
      id: "report_1", caseId: "case_1", title: "Assessment", status: "draft" as const,
      executiveSummary: "Verified finding", scope: "API", methodology: "Replay",
      limitations: [], findingFactIds: ["finding_1"], attackPathIds: [],
      evidenceRefs: ["evidence_1"], sourceRunIds: ["run_1"], version: 1,
      reviewStatus: "current" as const, reviewReasons: [], dependencyVersions: { finding_1: 0, evidence_1: 0 },
      createdAt: "now", updatedAt: "now",
    };
    useStore.getState().handleRuntimeEvent({ type: "security_report_created", report });
    useStore.getState().handleRuntimeEvent({
      type: "security_report_updated",
      report: { ...report, status: "final", version: 2, updatedAt: "later" },
    });
    expect(useStore.getState().securityReports).toEqual([
      { ...report, status: "final", version: 2, updatedAt: "later" },
    ]);
  });
});

const warning = {
  id: "warn_1",
  caseId: "case_1",
  level: "critical" as const,
  issueType: "goal_drift" as const,
  subject: "run:run_1",
  title: "偏离目标",
  description: "一直在测无关接口",
  relatedFacts: [],
  relatedTasks: [],
  suggestedAction: "回到登录流程",
  suggestedGoal: "",
  status: "open" as const,
  fingerprint: "fp_1",
  occurrenceCount: 2,
  lastObservedAt: new Date().toISOString(),
  correctionCount: 1,
  correctionResolvedCount: 0,
  correctionFailedCount: 0,
  correctionOutcome: "pending" as const,
  correctionEvidence: null,
  lastCorrectionAt: new Date().toISOString(),
  lastCorrectionTrigger: "interval",
  escalationReason: null,
  relatedRunId: "run_1",
  resolvedAt: null,
  createdAt: new Date().toISOString(),
};

describe("store observer confirmation", () => {
  beforeEach(() => {
    resetStore();
  });

  it("sets pending confirmation and opens the observer dialog on agent_run_needs_confirmation", () => {
    useStore.getState().handleRuntimeEvent({ type: "agent_run_needs_confirmation", caseId: "case_1", runId: "run_1", warning });
    expect(useStore.getState().pendingConfirmation).toEqual({ runId: "run_1", warning });
    expect(useStore.getState().knowledgeDialog).toBe("observer");
    expect(useStore.getState().agentEvents.at(-1)?.text).toContain("偏离目标");
    expect(useStore.getState().toast?.message).toContain("偏离目标");
  });

  it("ignores confirmation events for other cases", () => {
    useStore.getState().handleRuntimeEvent({ type: "agent_run_needs_confirmation", caseId: "case_2", runId: "run_1", warning });
    expect(useStore.getState().pendingConfirmation).toBeNull();
    expect(useStore.getState().knowledgeDialog).toBeNull();
  });

  it("clears the current case when a delete event arrives over websocket", () => {
    useStore.getState().handleRuntimeEvent({ type: "case_deleted", caseId: "case_1" });

    expect(useStore.getState().caseId).toBeNull();
    expect(useStore.getState().traffic).toEqual([]);
  });
});

describe("store token usage", () => {
  beforeEach(() => {
    resetStore();
  });

  it("resets token usage when a run starts", () => {
    useStore.setState({
      tokenUsage: { promptTokens: 99, completionTokens: 99, totalTokens: 99 },
    });
    useStore.getState().handleRuntimeEvent({
      type: "agent_run_started",
      run: {
        id: "run_1",
        caseId: "case_1",
        goal: "test",
        status: "running",
        createdAt: "now",
        startedAt: "now",
        finishedAt: null,
        interruptReason: null,
        completionReason: null,
        error: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    });
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("updates cumulative token usage on agent_usage events", () => {
    useStore.getState().handleRuntimeEvent({
      type: "agent_usage",
      source: "agent",
      caseId: "case_1",
      runId: "run_1",
      usageId: "usage_1",
      turn: 1,
      createdAt: "now",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      currency: "USD",
      inputCostMicros: 20,
      outputCostMicros: 50,
      totalCostMicros: 70,
      cumulativePromptTokens: 10,
      cumulativeCompletionTokens: 5,
      cumulativeTotalTokens: 15,
    });
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    useStore.getState().handleRuntimeEvent({
      type: "agent_usage",
      source: "observer",
      caseId: "case_1",
      runId: "run_1",
      usageId: "usage_2",
      turn: 2,
      createdAt: "later",
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      currency: "USD",
      inputCostMicros: 6,
      outputCostMicros: 20,
      totalCostMicros: 26,
      cumulativePromptTokens: 13,
      cumulativeCompletionTokens: 7,
      cumulativeTotalTokens: 20,
    });
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 13, completionTokens: 7, totalTokens: 20 });
    expect(useStore.getState().tokenUsageHistory).toMatchObject([
      { id: "usage_1", turn: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, totalCostMicros: 70 },
      { id: "usage_2", turn: 2, promptTokens: 3, completionTokens: 2, totalTokens: 5, totalCostMicros: 26 },
    ]);
  });

  it("ignores agent_usage events for other cases", () => {
    useStore.getState().handleRuntimeEvent({
      type: "agent_usage",
      source: "agent",
      caseId: "case_2",
      runId: "run_1",
      usageId: "usage_other",
      turn: 1,
      createdAt: "now",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      currency: null,
      inputCostMicros: null,
      outputCostMicros: null,
      totalCostMicros: null,
      cumulativePromptTokens: 10,
      cumulativeCompletionTokens: 5,
      cumulativeTotalTokens: 15,
    });
    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(useStore.getState().tokenUsageHistory).toEqual([]);
  });

  it("syncs final token usage from completed run events", () => {
    useStore.getState().handleRuntimeEvent({
      type: "agent_run_completed",
      content: "done",
      run: {
        id: "run_1",
        caseId: "case_1",
        goal: "test",
        status: "completed",
        createdAt: "now",
        startedAt: "now",
        finishedAt: "later",
        interruptReason: null,
        completionReason: "done",
        error: null,
        promptTokens: 36_194,
        completionTokens: 1_413,
        totalTokens: 37_607,
      },
    });

    expect(useStore.getState().tokenUsage).toEqual({ promptTokens: 36_194, completionTokens: 1_413, totalTokens: 37_607 });
  });
});

describe("store agent tool events", () => {
  beforeEach(() => {
    resetStore();
  });

  it("shows blocked tool calls in the run console", () => {
    useStore.getState().handleRuntimeEvent({
      type: "agent_tool_blocked",
      caseId: "case_1",
      runId: "run_1",
      tool: "exec_command",
      input: "{\"command\":\"false\"}",
      reason: "identical call already failed in this run",
    });

    expect(useStore.getState().agentEvents.at(-1)).toEqual(expect.objectContaining({
      kind: "tool_result",
      text: "exec_command blocked → identical call already failed in this run\n{\"command\":\"false\"}",
    }));
  });
});

describe("store context inspector", () => {
  beforeEach(() => resetStore());

  it("selects traffic as inspector context and closes it after persisted evidence is cleared", () => {
    useStore.getState().selectTraffic("traffic_1");
    expect(useStore.getState()).toMatchObject({ selectedTrafficId: "traffic_1", inspectorMode: "traffic" });

    useStore.getState().handleRuntimeEvent({ type: "traffic_cleared", caseId: "case_1" });
    expect(useStore.getState()).toMatchObject({ traffic: [], selectedTrafficId: null, inspectorMode: "overview" });
  });

  it("tracks Observer reviews, corrections, failures, and attributed tokens", () => {
    useStore.getState().handleRuntimeEvent({
      type: "observer_warning",
      warning,
    });
    useStore.getState().handleRuntimeEvent({
      type: "observer_review_completed",
      caseId: "case_1",
      runId: "run_1",
      trigger: "interval",
      warningCount: 1,
      correctionCount: 1,
      durationMs: 42,
      totalTokens: 120,
      strategyAudit: {
        id: "audit_1",
        caseId: "case_1",
        runId: "run_1",
        trigger: "interval",
        offeredCandidates: [{
          strategyId: "warn_strategy",
          relevanceScore: 124,
          relevanceReasons: ["fingerprint_match"],
          effectiveness: "active",
          usageCount: 0,
          successCount: 0,
          failureCount: 0,
        }],
        adoptions: [{ strategyId: "warn_strategy", warningIds: [warning.id] }],
        ignoredStrategyIds: [],
        contextCharacters: 284,
        createdAt: "now",
      },
    });
    useStore.getState().handleRuntimeEvent({
      type: "observer_review_failed",
      caseId: "case_1",
      runId: "run_1",
      error: "provider unavailable",
    });

    expect(useStore.getState().observerTelemetry).toEqual({
      reviewCount: 1,
      correctionCount: 1,
      correctionResolvedCount: 0,
      correctionFailedCount: 0,
      failureCount: 1,
      totalTokens: 120,
      lastTrigger: "interval",
      lastDurationMs: 42,
    });
    expect(useStore.getState().observerStrategyAudits).toEqual([
      expect.objectContaining({ id: "audit_1", contextCharacters: 284 }),
    ]);
  });

  it("restores Observer review counts and tokens from persisted run usage", () => {
    const telemetry = observerTelemetryFromHistory([
      { id: "u1", runId: "run_1", caseId: "case_1", turn: 1, source: "agent", promptTokens: 10, completionTokens: 2, totalTokens: 12, currency: null, inputCostMicros: null, outputCostMicros: null, totalCostMicros: null, createdAt: "now" },
      { id: "u2", runId: "run_1", caseId: "case_1", turn: 2, source: "observer", promptTokens: 20, completionTokens: 3, totalTokens: 23, currency: null, inputCostMicros: null, outputCostMicros: null, totalCostMicros: null, createdAt: "later" },
    ], [warning]);

    expect(telemetry).toMatchObject({ reviewCount: 1, correctionCount: 1, totalTokens: 23 });
  });
});
describe("store traffic synchronization", () => {
  beforeEach(() => resetStore());

  it("enriches a captured response in place without duplicating it", () => {
    const entry = useStore.getState().traffic[0];
    useStore.getState().addEntry({ ...entry, responseBody: "complete", responseSize: 8, contentType: "text/plain" });
    expect(useStore.getState().traffic).toHaveLength(1);
    expect(useStore.getState().traffic[0]).toMatchObject({ responseBody: "complete", responseSize: 8, contentType: "text/plain" });
  });
});
describe("store feedback notices", () => {
  it("assigns semantic tones and suppresses consecutive duplicates", () => {
    useStore.getState().showToast("Settings saved");
    const first = useStore.getState().toast;
    expect(first?.tone).toBe("success");

    useStore.getState().showToast("Settings saved");
    expect(useStore.getState().toast?.id).toBe(first?.id);

    useStore.getState().showToast("Unable to reach server");
    expect(useStore.getState().toast?.tone).toBe("error");
  });
});

describe("store agent streaming", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders one exact message from stream events and the persisted text event", () => {
    const handle = useStore.getState().handleRuntimeEvent;
    handle({ type: "agent_stream_start", caseId: "case_1", runId: "run_1", messageId: "msg_1" });
    handle({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "msg_1", delta: "已将 " });
    handle({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "msg_1", delta: "127.0.0.1 加入范围" });
    handle({ type: "agent_stream_end", caseId: "case_1", runId: "run_1", messageId: "msg_1", content: "已将 127.0.0.1 加入范围。" });
    handle({ type: "agent_reasoning", caseId: "case_1", content: "等待用户批准" });
    handle({ type: "agent_text", caseId: "case_1", content: "已将 127.0.0.1 加入范围。" });

    expect(useStore.getState().agentEvents).toEqual([
      expect.objectContaining({ kind: "text", text: "已将 127.0.0.1 加入范围。" }),
      expect.objectContaining({ kind: "reasoning", text: "等待用户批准" }),
    ]);
    expect(useStore.getState().streamedAgentTexts).toEqual([]);
  });

  it("keeps distinct streamed messages separate", () => {
    const handle = useStore.getState().handleRuntimeEvent;
    for (const [messageId, content] of [["msg_1", "first"], ["msg_2", "second"]] as const) {
      handle({ type: "agent_stream_start", caseId: "case_1", runId: "run_1", messageId });
      handle({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId, delta: content });
      handle({ type: "agent_stream_end", caseId: "case_1", runId: "run_1", messageId, content });
      handle({ type: "agent_text", caseId: "case_1", content });
    }

    expect(useStore.getState().agentEvents.map((event) => event.text)).toEqual(["first", "second"]);
  });

  it("coalesces stream deltas arriving in the same render frame", async () => {
    const handle = useStore.getState().handleRuntimeEvent;
    handle({ type: "agent_stream_start", caseId: "case_1", runId: "run_1", messageId: "msg_batch" });
    let updates = 0;
    const unsubscribe = useStore.subscribe(() => { updates += 1; });

    handle({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "msg_batch", delta: "a" });
    handle({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "msg_batch", delta: "b" });
    handle({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "msg_batch", delta: "c" });

    expect(useStore.getState().agentEvents.at(-1)?.text).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 25));
    unsubscribe();

    expect(useStore.getState().agentEvents.at(-1)?.text).toBe("abc");
    expect(updates).toBe(1);
  });

  it("keeps only the recent client-side Agent working set", () => {
    const events = Array.from({ length: CLIENT_AGENT_EVENT_LIMIT + 2 }, (_, index) => index);
    const recent = takeRecent(events, CLIENT_AGENT_EVENT_LIMIT);

    expect(recent).toHaveLength(CLIENT_AGENT_EVENT_LIMIT);
    expect(recent[0]).toBe(2);
    expect(recent.at(-1)).toBe(CLIENT_AGENT_EVENT_LIMIT + 1);
  });

  it("retains a budget-exhausted run as a continuation target", () => {
    useStore.getState().handleRuntimeEvent({
      type: "agent_run_needs_continuation",
      reason: "run budget exhausted after 3 turns",
      run: {
        id: "run_1",
        caseId: "case_1",
        goal: "test the login flow",
        status: "needs_continuation",
        createdAt: "now",
        startedAt: "now",
        finishedAt: "later",
        interruptReason: null,
        completionReason: "run budget exhausted after 3 turns",
        error: null,
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
    });

    expect(useStore.getState().activeRun).toBeNull();
    expect(useStore.getState().continuationRun).toMatchObject({
      id: "run_1",
      goal: "test the login flow",
      status: "needs_continuation",
    });
    expect(useStore.getState().agentBusy).toBe(false);
  });
});
describe("store agent interventions", () => {
  beforeEach(() => {
    resetStore();
  });

  it("does not let an old approval response clear a newer request", () => {
    useStore.setState({ pendingApproval: { approvalId: "approval_new", tool: "write_file", input: "{}" } });

    useStore.getState().handleRuntimeEvent({
      type: "approval_resolved",
      caseId: "case_1",
      approvalId: "approval_old",
      tool: "exec_command",
      decision: "approved",
    });

    expect(useStore.getState().pendingApproval?.approvalId).toBe("approval_new");
  });

  it("keeps a scope proposal pending when an unrelated scope update arrives", () => {
    useStore.setState({ pendingScope: { host: "target.example", reason: "requested target" } });

    useStore.getState().handleRuntimeEvent({
      type: "scope_updated",
      caseId: "case_1",
      allowHosts: ["cdn.example"],
    });

    expect(useStore.getState().pendingScope?.host).toBe("target.example");
  });

  it("records a rejected scope outcome and clears only the matching proposal", () => {
    useStore.setState({ pendingScope: { host: "target.example", reason: "requested target" } });

    useStore.getState().handleRuntimeEvent({
      type: "scope_expansion_rejected",
      caseId: "case_1",
      host: "target.example",
    });

    expect(useStore.getState().pendingScope).toBeNull();
    expect(useStore.getState().agentEvents.at(-1)).toEqual(expect.objectContaining({
      kind: "done",
      text: "Scope kept blocked: target.example",
    }));
  });

  it("applies hypothesis lifecycle events without refetching the pool", () => {
    const createdAt = "2026-07-22T00:00:00.000Z";
    const transition = { id: "hyptr_1", kind: "created" as const, fromStatus: null, toStatus: "candidate" as const, previousScore: null, nextScore: 50, reason: "Observed evidence.", evidenceFactIds: ["fact_1"], createdAt };
    const hypothesis = { id: "hyp_1", caseId: "case_1", runId: "run_1", statement: "Object access may be unauthorized", status: "candidate" as const, priorityScore: 50, basedOnFactIds: ["fact_1"], relatedTaskIds: [], createdAt, updatedAt: createdAt, updateCount: 0, auditTrail: [transition] };
    useStore.getState().handleRuntimeEvent({ type: "hypothesis_created", hypothesis, transition });
    expect(useStore.getState().hypotheses).toEqual([hypothesis]);

    const promoted = { ...transition, id: "hyptr_2", kind: "promoted" as const, fromStatus: "candidate" as const, toStatus: "active" as const, previousScore: 50, nextScore: 80, reason: "Entered top five." };
    const updated = { ...hypothesis, status: "active" as const, priorityScore: 80, updateCount: 1, auditTrail: [transition, promoted] };
    useStore.getState().handleRuntimeEvent({ type: "hypothesis_updated", hypothesis: updated, transition: promoted });
    expect(useStore.getState().hypotheses).toEqual([updated]);
  });
});

describe("graph-driven inspector selection", () => {
  it("selectTask clears every other selection and switches inspector mode", () => {
    useStore.setState({
      selectedTrafficId: "traf_1",
      selectedFactId: "fact_1",
      selectedAgentEvent: { kind: "tool_call", label: "x", text: "x" },
      selectedTimelineNodeId: "tl_1",
      inspectorMode: "traffic",
    });

    useStore.getState().selectTask("task_1");

    const state = useStore.getState();
    expect(state.selectedTaskId).toBe("task_1");
    expect(state.selectedTrafficId).toBeNull();
    expect(state.selectedFactId).toBeNull();
    expect(state.selectedAgentEvent).toBeNull();
    expect(state.selectedTimelineNodeId).toBeNull();
    expect(state.inspectorMode).toBe("task");

    useStore.getState().selectTask(null);
    expect(useStore.getState().inspectorMode).toBe("overview");
  });

  it("selectTimelineNode clears every other selection and switches inspector mode", () => {
    useStore.setState({ selectedTaskId: "task_1", selectedFactId: "fact_1", inspectorMode: "task" });

    useStore.getState().selectTimelineNode("tl_9");

    const state = useStore.getState();
    expect(state.selectedTimelineNodeId).toBe("tl_9");
    expect(state.selectedTaskId).toBeNull();
    expect(state.selectedFactId).toBeNull();
    expect(state.inspectorMode).toBe("timeline");
  });

  it("existing selectors clear graph-driven selections", () => {
    useStore.setState({ selectedTaskId: "task_1", selectedTimelineNodeId: "tl_9", inspectorMode: "task" });

    useStore.getState().selectFact("fact_2");

    const state = useStore.getState();
    expect(state.selectedFactId).toBe("fact_2");
    expect(state.selectedTaskId).toBeNull();
    expect(state.selectedTimelineNodeId).toBeNull();
    expect(state.inspectorMode).toBe("finding");
  });
});
