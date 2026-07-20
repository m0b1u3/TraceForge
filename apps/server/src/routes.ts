import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { cases, identityContexts, attackPaths, securityReportRevisions, securityReports, trafficEntries, facts, tasks, timeline, actionCards, decisions, agentEvents, observerWarnings, runCognitiveState, hypotheses, contextSummaries, knowledgeUsage } from "./db/schema.js";
import { CaseStore } from "./stores/case-store.js";
import { TrafficStore } from "./stores/traffic-store.js";
import { FactStore } from "./stores/fact-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { EventBus } from "./event-bus.js";
import type { Task, ObserverWarning, CaseSummary, Fact } from "@traceforge/shared";
import type { LlmProvider } from "@traceforge/llm";
import { loadLlmConfig, createProviderFromConfig } from "@traceforge/llm";
import { ActionCardStore } from "./stores/action-store.js";
import { DecisionStore } from "./stores/decision-store.js";
import {
  ToolRegistry, ApprovalGate, AgentRuntime,
  makeListTrafficTool, makeGetTrafficTool,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeReopenTaskTool, makeRevertDoneTaskTool,
  makeHttpReplayTool, makeProposeScopeExpansionTool, makeBrowserTools,
  makeReplayTrafficTool, makeExtractApiEndpointsTool,
  makeCompareIdentityTrafficTool, makeListIdentitiesTool, makeRecordIdentityTool, makeUseBrowserIdentityTool,
  makeListAttackPathsTool, makeRecordAttackPathTool,
  makeListSecurityReportsTool, makeRecordSecurityReportTool,
  McpManager, mcpToolToDescriptor, Observer, LlmQueryExpander,
  makeReevaluateFactsTool, FailureMemory, makeDownloadTool,
  type AgentRunBudget, type ObserverReviewTrigger,
} from "@traceforge/extension";
import { BrowserSession } from "./browser-session.js";
import { ObserverWarningStore } from "./stores/observer-store.js";
import { AgentEventStore } from "./stores/agent-event-store.js";
import { ApprovalRegistry } from "./agent-approvals.js";
import { AgentRunRegistry } from "./agent-runs.js";
import { SessionStateStore } from "./stores/session-state-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { ContextSummaryStore } from "./stores/context-summary-store.js";
import { buildContext, compressFar, deriveContextBudget, estimateTokens, shouldCompressFarHistory } from "@traceforge/reasoning-core";
import { makeUpdateSessionStateTool, makeRecordHypothesisTool, makeResolveHypothesisTool, makeSearchFactsTool, makeGetFactDetailTool, makeSearchTrafficTool, makeRecallConversationTool, makeRecallCaseKnowledgeTool } from "@traceforge/extension";
import { LlmConfigService, type LlmConfigDto } from "./llm-config-service.js";
import { calculateUsageCost } from "./llm-cost.js";
import { PendingInterventionRegistry } from "./pending-interventions.js";
import { AgentRunStore } from "./stores/agent-run-store.js";
import { observerFingerprint, observerIntervention, validatedObserverLevel } from "./observer-policy.js";
import { HypothesisScheduler } from "./hypothesis-scheduler.js";
import { IdentityStore } from "./stores/identity-store.js";
import { AttackPathStore } from "./stores/attack-path-store.js";
import { SecurityReportStore } from "./stores/security-report-store.js";
import { securityReportExport, securityReportMarkdown } from "./security-report-export.js";
import { ObserverScheduler } from "./observer-scheduler.js";
import { buildSharedKnowledge } from "./shared-knowledge.js";
import { KnowledgeUsageStore, type KnowledgeRef } from "./stores/knowledge-usage-store.js";
import { KnowledgeOutcomeTracker } from "./knowledge-outcome.js";
import { buildExplorationAdvisory } from "./exploration-advisor.js";
import { formatAttackPathPlan, rankAttackPathBreakpoints } from "./attack-path-planner.js";
import { formatEvidenceGapPlan, mapEvidenceGaps } from "./evidence-gap-planner.js";

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
  const factStore = new FactStore(db);
  const taskStore = new TaskStore(db);
  const timelineStore = new TimelineStore(db);

  // model/baseUrl/provider 全部来自 config/llm.json；无配置或无 key 直接失败，禁止静默空跑。
  const llm: LlmProvider = provider ?? createProviderFromConfig(loadLlmConfig());
  const queryExpander = new LlmQueryExpander(llm);

  if (llmService) {
    app.get("/api/config/llm", async () => llmService.load());

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
  const agentEventStore = new AgentEventStore(db);
  const sessionStore = new SessionStateStore(db);
  const hypothesisStore = new HypothesisStore(db);
  const hypothesisScheduler = new HypothesisScheduler(hypothesisStore);
  const identityStore = new IdentityStore(db);
  const attackPathStore = new AttackPathStore(db);
  const securityReportStore = new SecurityReportStore(db);
  const knowledgeUsageStore = new KnowledgeUsageStore(db);
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

  app.post("/api/cases", async (req) => {
    const body = req.body as { name: string; allowHosts: string[]; denyHosts?: string[] };
    const c = cases.create(body.name, [
      { caseId: "pending", allowHosts: body.allowHosts, denyHosts: body.denyHosts ?? [] },
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
    db.delete(agentEvents).where(eq(agentEvents.caseId, id)).run();
    db.delete(observerWarnings).where(eq(observerWarnings.caseId, id)).run();
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
        },
        () => runs.getActiveByCase(id)?.run.id ?? null,
      );
      browserSessions.set(id, session);
    }
    try {
      await session.start();
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
    const task = taskStore.updateStatus(taskId, status, reason);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const entry = timelineStore.append(task.caseId, "task_updated", `Task ${task.title} → ${status}`, task.id);
    bus.emit({ type: "task_updated", task });
    bus.emit({ type: "timeline_appended", entry });
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

    const { goal, budget } = req.body as { goal: string; budget?: Partial<AgentRunBudget> };
    if (!goal?.trim()) return reply.code(400).send({ error: "goal required" });
    let active;
    try {
      active = runs.start(id, goal.trim());
    } catch (err) {
      return reply.code(409).send({ error: "active run exists", reason: (err as Error).message });
    }
    for (const warning of observerStore.resolveActiveFromOtherRuns(id, active.run.id)) {
      bus.emit({ type: "observer_warning_updated", warning });
    }

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

      const runObserverReviewUnsafe = async (
        reviewRunId: string,
        reviewTrajectory: string,
        trigger: ObserverReviewTrigger,
      ): Promise<{ action: "continue" | "pause"; reason?: string; steering?: string[] }> => {
        const startedAt = Date.now();
        const factsSummary = factStore.listByCase(id).map((f) => `${f.id} [${f.type}] ${f.title}`).join("\n") || "(无)";
        const tasksSummary = taskStore.listByCase(id).map((t) => `${t.id} [${t.status}] ${t.title}`).join("\n") || "(无)";
        const result = await new Observer(llm).review(id, { goal, trajectory: reviewTrajectory, factsSummary, tasksSummary });
        if (result.usage.totalTokens > 0) recordRunUsage("observer", result.usage);
        if (result.error) {
          bus.emit({ type: "observer_review_failed", caseId: id, runId: reviewRunId, error: result.error });
          return { action: "continue" };
        }
        let pauseReason: string | undefined;
        const steering: string[] = [];
        const observedFingerprints = new Set<string>();
        const validFactIds = new Set(factStore.listByCase(id).map((fact) => fact.id));
        const validTaskIds = new Set(taskStore.listByCase(id).map((task) => task.id));
        for (const w of result.warnings) {
          const level = validatedObserverLevel(w, validFactIds, validTaskIds);
          const fingerprint = observerFingerprint(w);
          observedFingerprints.add(fingerprint);
          const existing = observerStore.getActiveByFingerprint(id, reviewRunId, fingerprint);
          if (existing) {
            if (existing.status === "escalated") continue;
            const warning = observerStore.observeAgain(existing.id, {
              level,
              escalationReason: level === "critical"
                ? "Critical evidence remained unresolved after the Observer correction window."
                : null,
            });
            if (!warning) continue;
            bus.emit({ type: "observer_warning_updated", warning });
            const intervention = observerIntervention(warning, {
              allowPause: trigger === "high_risk" || trigger === "evidence_conflict",
            });
            if (intervention.pauseReason && !pauseReason) {
              pauseReason = intervention.pauseReason;
              bus.emit({ type: "agent_run_needs_confirmation", caseId: id, runId: reviewRunId, warning });
            } else if (intervention.steering) {
              steering.push(intervention.steering);
            }
            continue;
          }
          const now = new Date().toISOString();
          const warning = observerStore.create({
            ...w,
            level,
            status: "detected",
            fingerprint,
            occurrenceCount: 1,
            lastObservedAt: now,
            escalationReason: null,
            relatedRunId: reviewRunId,
            suggestedGoal: w.suggestedGoal || `[Observer correction]\n${w.suggestedAction}`,
            resolvedAt: null,
          });
          bus.emit({ type: "observer_warning", warning });
        }
        const correcting = observerStore.listByCase(id, { status: "correcting" }).warnings;
        for (const warning of correcting) {
          if (warning.relatedRunId !== reviewRunId || observedFingerprints.has(warning.fingerprint)) continue;
          const resolved = observerStore.updateStatus(warning.id, "resolved");
          if (resolved) bus.emit({ type: "observer_warning_updated", warning: resolved });
        }
        bus.emit({
          type: "observer_review_completed",
          caseId: id,
          runId: reviewRunId,
          trigger,
          warningCount: result.warnings.length,
          correctionCount: steering.length,
          durationMs: Date.now() - startedAt,
          totalTokens: result.usage.totalTokens,
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
      ): Promise<{ action: "continue" | "pause"; reason?: string; steering?: string[] }> => {
        const normalizedTrajectory = reviewTrajectory.trim();
        if (!normalizedTrajectory) return { action: "continue" };
        const digest = createHash("sha256").update(normalizedTrajectory).digest("hex");
        if (digest === lastObserverReviewDigest || observerReviewInFlight) return { action: "continue" };
        lastObserverReviewDigest = digest;
        observerReviewInFlight = runObserverReviewUnsafe(reviewRunId, normalizedTrajectory, trigger);
        try {
          return await observerReviewInFlight;
        } catch (error) {
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
    registry.register(makeRecordTaskTool(id, taskStore, runTimeline, (e) => bus.emit(e), runId, hypothesisStore));
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
    const getEvidenceGapPlan = () => formatEvidenceGapPlan(mapEvidenceGaps({
      facts: factStore.listByCase(id),
      paths: attackPathStore.listByCase(id),
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
    registry.register(makeDownloadTool({ caseId: id, workspaceRoot: projectRoot }));

    // 若该 case 有共享浏览器会话，把浏览器工具纳入 agent 工具集
    const browserSession = browserSessions.get(id);
    if (browserSession) {
      for (const t of makeBrowserTools(browserSession, c.scopeRules)) registry.register(t);
      registry.register(makeUseBrowserIdentityTool(id, identityStore, browserSession));
    }

    // 若配置了 MCP server，把其工具纳入 agent 工具集；工具名直接使用 MCP toolName。
    if (mcp) {
      for (const h of mcp.listTools()) registry.register(mcpToolToDescriptor(h, mcp));
    }

    const gate = new ApprovalGate(async (tool, input) => {
      const approvalId = `appr_${randomUUID()}`;
      const serializedInput = JSON.stringify(input);
      pendingInterventions.setApproval(id, { approvalId, tool: tool.name, input: serializedInput });
      bus.emit({ type: "approval_requested", caseId: id, approvalId, tool: tool.name, input: serializedInput });
      const decision = await approvals.request(approvalId, running.abortController.signal);
      pendingInterventions.clearApproval(id, approvalId);
      agentEventStore.append(id, "done", `Approval ${decision}: ${tool.name}`);
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
认证端点测试顺序：当目标涉及登录或认证接口时，按以下顺序执行：
1. 先尝试一组常见/弱口令凭据（可控数量，不要无差别爆破）；
2. 复用从其他 Facts 中发现的疑似凭据或线索；
3. 若上述尝试均失败，记录一条说明阻塞原因的 Fact，然后再 pivot 到相邻攻击面（注册接口、找回密码、OAuth、会话管理、越权等）。
完成后用一句话总结。
失败记忆与在线工具回退：
- 禁止用完全相同的输入重复调用任何已经执行失败的工具（尤其是 exec_command 和脚本类调用）。如果一次调用返回错误、非零退出码或失败结果，立即用 record_fact 记录一条 type=failed_attempt 的 Fact，然后换用其他方法。
- 如果当前环境无法解决问题，调用 download_tool(url, filename, executable=true) 从网络下载现成工具，保存到 workspace/<caseId>/downloads/，然后通过 exec_command 执行（仍需用户批准）。
- 重试相同失败输入会被 runtime 自动拒绝，不要一直重复尝试，不要浪费轮次。`;

    const failedAttempts = factStore.listByCase(id)
      .filter((f) => f.type === "failed_attempt" && f.validity === "valid")
      .map((f) => {
        const v = f.value as { tool?: string; input?: unknown } | undefined;
        return { tool: v?.tool ?? f.title, input: v?.input ?? {} };
      });
    const failureMemory = new FailureMemory(failedAttempts);

    const trajectory: string[] = [];

    // 先取历史（此时不含当前 goal），构造近期对话
    const history = agentEventStore.listByCase(id);
    const recentConvo = history
      .filter((e) => e.kind === "user" || e.kind === "text" || e.kind === "done")
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
    const built = buildContext({
      goal,
      state: sessionStore.get(id, runId),
      recentConvo,
      factCount: factStore.listByCase(id).length,
      trafficCount: traffic.listByCase(id).length,
      summaryCount: contextSummaryStore.latest(id) ? 1 : 0,
      activeHypotheses: hypothesisStore.listByCase(id).filter((h) => h.runId === runId && h.status === "active"),
      activeTasks: taskStore.listByCase(id).filter((t) => t.runId === runId && ["open", "blocked", "running", "recheck_candidate"].includes(t.status)),
      doneTaskSummaries: taskStore.listByCase(id).filter((t) => t.runId === runId && t.status === "done").map((t) => `${t.title}：${t.reason || "完成"}`),
      farSummary: contextSummaryStore.latest(id)?.content,
      scopeHosts: c.scopeRules.flatMap((r) => r.allowHosts),
      sharedKnowledge: getSharedKnowledge(),
    }, { maxTokens: contextBudget.maxTokens, focusReserve: contextBudget.focusReserve });

    agentEventStore.append(id, "user", goal); // 存用户这句目标，刷新/切 Case 后历史可见完整双边对话
    agentEventStore.append(id, "started", `Started: ${goal}`);
    const observerScheduler = new ObserverScheduler();
    await new AgentRuntime(llm, registry, gate).run(
      `${system}\n\n${getAttackPathPlan()}\n\n${getEvidenceGapPlan()}`,
      built.messages,
      (e) => {
      if (e.type === "tool_call") { bus.emit({ type: "agent_tool_call", caseId: id, tool: e.name ?? "", input: e.content }); agentEventStore.append(id, "tool_call", `${e.name}(${e.content})`, e.name ?? undefined); trajectory.push(`[tool] ${e.name}(${e.content})`); }
      else if (e.type === "tool_result") { bus.emit({ type: "agent_tool_result", caseId: id, tool: e.name ?? "", content: e.content }); agentEventStore.append(id, "tool_result", `${e.name} → ${e.content}`, e.name ?? undefined); trajectory.push(`[result] ${e.name} → ${e.content}`); }
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
        if (interrupted) bus.emit({ type: "agent_run_interrupted", run: interrupted });
      }
    }, {
      signal: running.abortController.signal,
      runId,
      budget,
      reviewIntervalTurns: 6,
      getObserverReviewTrigger: () => observerScheduler.consume(),
      getSteeringMessages: () => runs.consumeSteering(runId),
      onTurnComplete: async (summary) => runObserverReview(summary.runId, summary.trajectory, summary.trigger),
      failureMemory,
      onBeforeToolExecute: (call) => {
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
          failedAttempts: factStore.listByCase(id).filter((fact) =>
            fact.type === "failed_attempt" && fact.validity === "valid" && fact.sourceRunId !== runId),
          alternatives,
        });
      },
      onToolExecuted: (report) => {
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
        const settledKnowledge = knowledgeOutcomeTracker.settle(report, referencedKnowledge);
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
        const replanTriggers = new Set([
          "record_fact",
          "record_hypothesis",
          "resolve_hypothesis",
          "record_task",
          "record_identity",
        "compare_identity_traffic",
        "record_attack_path",
          "propose_scope_expansion",
        ]);
        if (report.ok && replanTriggers.has(report.name)) {
          try {
            const rebalanced = hypothesisScheduler.rebalance(id, runId);
            sessionStore.upsert(id, { activeHypothesisIds: rebalanced.active.map((item) => item.id) }, runId);
            const activeSummary = rebalanced.active
              .map((item) => `${item.id}(${item.priorityScore ?? 0})`)
              .join(", ") || "none";
            const pathPlan = getAttackPathPlan();
            const evidenceGapPlan = getEvidenceGapPlan();
            const entry = timelineStore.append(
              id,
              "investigation_replan_requested",
              `Trigger=${report.name}; active hypotheses=${activeSummary}; ${pathPlan.replace(/\n/g, " | ")}; ${evidenceGapPlan.replace(/\n/g, " | ")}`,
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
              "Re-evaluate the current task against both the ranked hypotheses and path breakpoints. Continue when it advances a leading breakpoint; otherwise explain the evidence-backed pivot before selecting the next verification task.",
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
        if (report.ok) return;
        if (report.rejected) return;
        if (report.blocked) return;
        if (report.transient) return;
        if (report.failureClass && report.failureClass !== "permanent") return;
        const fact = factStore.create(id, {
          type: "failed_attempt",
          title: `Failed attempt: ${report.name}`,
          value: { tool: report.name, input: report.input, reason: report.content },
          source: { type: "agent", ref: runId },
          confidence: 1,
          tags: ["failure-memory"],
        });
        const entry = timelineStore.append(id, "fact_created", `Failed attempt: ${report.name}`, fact.id);
        bus.emit({ type: "fact_created", fact });
        bus.emit({ type: "timeline_appended", entry });
      },
    });

    const afterRun = runs.get(runId)?.run;
    if (afterRun && afterRun.status === "running") {
      const completed = runs.complete(runId, trajectory.at(-1) ?? "completed");
      if (completed) bus.emit({ type: "agent_run_completed", run: completed, content: trajectory.at(-1) ?? "" });
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
            .filter((e) => e.kind === "user" || e.kind === "text" || e.kind === "done")
            .map((e) => `${e.kind === "user" ? "User" : "Agent"}: ${e.text}`)
            .join("\n");
          const farHistoryTokens = estimateTokens(convoText);
          if (convoText.trim() && shouldCompressFarHistory({ farHistoryTokens, budget: contextBudget })) {
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
        const current = runs.get(active.run.id);
        if (current?.run.status === "interrupting") {
          const interrupted = runs.markInterrupted(active.run.id, current.run.interruptReason ?? (err as Error).message);
          if (interrupted) bus.emit({ type: "agent_run_interrupted", run: interrupted });
        } else {
          const failed = runs.fail(active.run.id, (err as Error).message);
          if (failed) {
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
