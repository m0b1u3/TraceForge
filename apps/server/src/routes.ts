import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { chromium } from "playwright";
import { checkScope } from "@traceforge/tool-resolver";
import type { Db } from "./db/client.js";
import { CaseStore } from "./stores/case-store.js";
import { TrafficStore } from "./stores/traffic-store.js";
import { FactStore } from "./stores/fact-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { EventBus } from "./event-bus.js";
import type { Task } from "@traceforge/shared";
import type { LlmProvider } from "@traceforge/llm";
import { loadLlmConfig, createProviderOrMock } from "@traceforge/llm";
import { FactExtractor, ActionPlanner } from "@traceforge/reasoning-core";
import { CandidateStore } from "./candidate-store.js";
import { ActionCardStore } from "./stores/action-store.js";
import { DecisionStore } from "./stores/decision-store.js";
import { ActionCandidateStore } from "./action-candidate-store.js";
import {
  ToolRegistry, ApprovalGate, AgentRuntime,
  makeListTrafficTool, makeGetTrafficTool,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeHttpReplayTool, makeProposeScopeExpansionTool,
} from "@traceforge/extension";
import { ApprovalRegistry } from "./agent-approvals.js";

export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  bus: EventBus,
  provider?: LlmProvider,
): void {
  const cases = new CaseStore(db);
  const traffic = new TrafficStore(db);
  const factStore = new FactStore(db);
  const taskStore = new TaskStore(db);
  const timelineStore = new TimelineStore(db);

  // model/baseUrl/provider 全部来自 config/llm.json；无配置或无 key 回退空候选 Mock
  const llm: LlmProvider = provider ?? createProviderOrMock(loadLlmConfig());
  const extractor = new FactExtractor(llm);
  const candidateStore = new CandidateStore();
  const planner = new ActionPlanner(llm);
  const actionStore = new ActionCardStore(db);
  const decisionStore = new DecisionStore(db);
  const actionCandidateStore = new ActionCandidateStore();

  app.post("/api/cases", async (req) => {
    const body = req.body as { name: string; allowHosts: string[]; denyHosts?: string[] };
    const c = cases.create(body.name, [
      { caseId: "pending", allowHosts: body.allowHosts, denyHosts: body.denyHosts ?? [] },
    ]);
    bus.emit({ type: "case_created", case: c });
    return c;
  });

  app.get("/api/cases", async () => cases.list());

  app.get("/api/cases/:id/traffic", async (req) => {
    const { id } = req.params as { id: string };
    return traffic.listByCase(id);
  });

  app.post("/api/cases/:id/open", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { url } = req.body as { url: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });

    const verdict = checkScope(url, c.scopeRules);
    if (!verdict.allowed) {
      bus.emit({ type: "scope_violation", caseId: id, url, reason: verdict.reason });
      return reply.code(403).send({ error: "out of scope", reason: verdict.reason });
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("response", (res) => {
      const resVerdict = checkScope(res.url(), c.scopeRules);
      if (!resVerdict.allowed) return; // 不捕获越界资源
      const entry = {
        id: `traf_${randomUUID()}`,
        caseId: id,
        url: res.url(),
        method: res.request().method(),
        requestHeaders: res.request().headers(),
        responseStatus: res.status(),
        responseBody: null as string | null,
        createdAt: new Date().toISOString(),
      };
      traffic.add(entry);
      bus.emit({ type: "response_captured", entry });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await browser.close();
    return { ok: true };
  });

  app.post("/api/cases/:id/facts", async (req) => {
    const { id } = req.params as { id: string };
    const input = req.body as Parameters<FactStore["create"]>[1];
    const fact = factStore.create(id, input);
    const entry = timelineStore.append(id, "fact_created", `Fact: ${fact.title}`, fact.id);
    bus.emit({ type: "fact_created", fact });
    bus.emit({ type: "timeline_appended", entry });
    return fact;
  });

  app.get("/api/cases/:id/facts", async (req) => {
    const { id } = req.params as { id: string };
    return factStore.listByCase(id);
  });

  app.post("/api/cases/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    const input = req.body as Parameters<TaskStore["create"]>[1];
    const task = taskStore.create(id, input);
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
    return timelineStore.listByCase(id);
  });

  app.post("/api/cases/:id/traffic/:trafId/extract", async (req, reply) => {
    const { id, trafId } = req.params as { id: string; trafId: string };
    const entry = traffic.listByCase(id).find((t) => t.id === trafId);
    if (!entry) return reply.code(404).send({ error: "traffic entry not found" });
    const candidates = await extractor.extract(id, entry);
    for (const c of candidates) candidateStore.put(c);
    bus.emit({ type: "candidates_extracted", caseId: id, candidates });
    return candidates;
  });

  app.post("/api/candidates/:candId/confirm", async (req, reply) => {
    const { candId } = req.params as { candId: string };
    const cand = candidateStore.get(candId);
    if (!cand) return reply.code(404).send({ error: "candidate not found" });
    const fact = factStore.create(cand.caseId, {
      type: cand.type,
      title: cand.title,
      value: cand.value,
      source: { type: "ai", ref: cand.sourceRef },
      confidence: cand.confidence,
      tags: [],
    });
    const entry = timelineStore.append(cand.caseId, "fact_created", `Fact (AI): ${fact.title}`, fact.id);
    bus.emit({ type: "fact_created", fact });
    bus.emit({ type: "timeline_appended", entry });
    candidateStore.delete(candId);
    return fact;
  });

  app.post("/api/candidates/:candId/reject", async (req, reply) => {
    const { candId } = req.params as { candId: string };
    const existed = candidateStore.delete(candId);
    if (!existed) return reply.code(404).send({ error: "candidate not found" });
    return { ok: true };
  });

  app.post("/api/cases/:id/plan-actions", async (req) => {
    const { id } = req.params as { id: string };
    const facts = factStore.listByCase(id);
    const candidates = await planner.plan(id, facts);
    for (const c of candidates) actionCandidateStore.put(c);
    bus.emit({ type: "action_candidates_generated", caseId: id, candidates });
    return candidates;
  });

  app.get("/api/cases/:id/actions", async (req) => {
    const { id } = req.params as { id: string };
    return actionStore.listByCase(id);
  });

  app.get("/api/cases/:id/decisions", async (req) => {
    const { id } = req.params as { id: string };
    return decisionStore.listByCase(id);
  });

  app.post("/api/action-candidates/:acandId/approve", async (req, reply) => {
    const { acandId } = req.params as { acandId: string };
    const cand = actionCandidateStore.get(acandId);
    if (!cand) return reply.code(404).send({ error: "action candidate not found" });
    const approved = { ...cand, status: "approved" as const, updatedAt: new Date().toISOString() };
    const action = actionStore.create(approved);
    const decision = decisionStore.create(cand.caseId, {
      decision: cand.title,
      basedOn: cand.evidenceRefs,
      reasoning: cand.reasoning,
      actionRef: cand.id,
      result: null,
      newFacts: [],
    });
    const entry = timelineStore.append(cand.caseId, "action_approved", `Action approved: ${action.title}`, action.id);
    bus.emit({ type: "action_approved", action });
    bus.emit({ type: "decision_recorded", decision });
    bus.emit({ type: "timeline_appended", entry });
    actionCandidateStore.delete(acandId);
    return { action, decision };
  });

  app.post("/api/action-candidates/:acandId/reject", async (req, reply) => {
    const { acandId } = req.params as { acandId: string };
    const existed = actionCandidateStore.delete(acandId);
    if (!existed) return reply.code(404).send({ error: "action candidate not found" });
    return { ok: true };
  });

  const approvals = new ApprovalRegistry();

  app.post("/api/cases/:id/agent/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });

    const registry = new ToolRegistry();
    registry.register(makeListTrafficTool(id, traffic));
    registry.register(makeGetTrafficTool(id, traffic));
    registry.register(makeRecordFactTool(id, factStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeRecordTaskTool(id, taskStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeRecordActionTool(id, factStore, actionStore, decisionStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeHttpReplayTool(c.scopeRules));
    registry.register(makeProposeScopeExpansionTool((host, reason) =>
      bus.emit({ type: "scope_expansion_proposed", caseId: id, host, reason })));

    const gate = new ApprovalGate(async (tool, input) => {
      const approvalId = `appr_${randomUUID()}`;
      bus.emit({ type: "approval_requested", caseId: id, approvalId, tool: tool.name, input: JSON.stringify(input) });
      const decision = await approvals.request(approvalId);
      bus.emit({ type: "approval_resolved", caseId: id, approvalId, decision });
      return decision;
    });

    const { goal } = req.body as { goal: string };
    const system = `你是 TraceForge 的授权渗透测试 agent。当前授权范围：${JSON.stringify(c.scopeRules)}。
你可以用工具查看流量、记录发现（Fact/Task/Action）、重放请求。证据驱动：记录动作前先记录支撑它的 Fact。
完成后用一句话总结。`;

    bus.emit({ type: "agent_started", caseId: id, goal });
    try {
      await new AgentRuntime(llm, registry, gate).run(system, goal, (e) => {
        if (e.type === "tool_call") bus.emit({ type: "agent_tool_call", caseId: id, tool: e.name ?? "", input: e.content });
        else if (e.type === "tool_result") bus.emit({ type: "agent_tool_result", caseId: id, tool: e.name ?? "", content: e.content });
        else if (e.type === "text") bus.emit({ type: "agent_text", caseId: id, content: e.content });
        else if (e.type === "done") bus.emit({ type: "agent_done", caseId: id, content: e.content });
      });
    } catch (err) {
      bus.emit({ type: "agent_error", caseId: id, content: (err as Error).message });
      return reply.code(500).send({ error: "agent run failed", reason: (err as Error).message });
    }
    return { ok: true };
  });

  app.post("/api/agent/approvals/:approvalId", async (req, reply) => {
    const { approvalId } = req.params as { approvalId: string };
    const { decision } = req.body as { decision: "approved" | "rejected" };
    const ok = approvals.resolve(approvalId, decision);
    if (!ok) return reply.code(404).send({ error: "approval not found" });
    return { ok: true };
  });
}
