import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
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
import { ActionCardStore } from "./stores/action-store.js";
import { DecisionStore } from "./stores/decision-store.js";
import {
  ToolRegistry, ApprovalGate, AgentRuntime,
  makeListTrafficTool, makeGetTrafficTool,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeReopenTaskTool, makeRevertDoneTaskTool,
  makeHttpReplayTool, makeProposeScopeExpansionTool, makeBrowserTools,
  McpManager, mcpToolToDescriptor, Observer, LlmQueryExpander,
} from "@traceforge/extension";
import { BrowserSession } from "./browser-session.js";
import { ObserverWarningStore } from "./stores/observer-store.js";
import { AgentEventStore } from "./stores/agent-event-store.js";
import { ApprovalRegistry } from "./agent-approvals.js";
import { AgentRunRegistry } from "./agent-runs.js";
import { SessionStateStore } from "./stores/session-state-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { ContextSummaryStore } from "./stores/context-summary-store.js";
import { buildContext, compressFar } from "@traceforge/reasoning-core";
import { makeUpdateSessionStateTool, makeRecordHypothesisTool, makeResolveHypothesisTool, makeSearchFactsTool, makeGetFactDetailTool, makeSearchTrafficTool, makeRecallConversationTool } from "@traceforge/extension";

export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  bus: EventBus,
  provider?: LlmProvider,
  mcp?: McpManager,
): void {
  const cases = new CaseStore(db);
  const traffic = new TrafficStore(db);
  const factStore = new FactStore(db);
  const taskStore = new TaskStore(db);
  const timelineStore = new TimelineStore(db);

  // model/baseUrl/provider 全部来自 config/llm.json；无配置或无 key 回退空候选 Mock
  const llm: LlmProvider = provider ?? createProviderOrMock(loadLlmConfig());
  const queryExpander = new LlmQueryExpander(llm);
  const actionStore = new ActionCardStore(db);
  const decisionStore = new DecisionStore(db);
  const observerStore = new ObserverWarningStore(db);
  const agentEventStore = new AgentEventStore(db);
  const sessionStore = new SessionStateStore(db);
  const hypothesisStore = new HypothesisStore(db);
  const contextSummaryStore = new ContextSummaryStore(db);

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

  // 人机共享浏览器会话（每 Case 一个），内存管理
  const browserSessions = new Map<string, BrowserSession>();

  app.post("/api/cases/:id/browser/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });
    let session = browserSessions.get(id);
    if (!session) {
      // 传 getter：对话中批准纳入新 host 后，正在运行的浏览器立即按最新范围放行流量
      session = new BrowserSession(id, () => cases.get(id)?.scopeRules ?? [], traffic, bus);
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
    session.acquireByHuman();
    return { ok: true, controller: session.controller() };
  });

  app.post("/api/cases/:id/browser/release", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = browserSessions.get(id);
    if (!session) return reply.code(404).send({ error: "no browser session" });
    session.releaseToLlm();
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
    return timelineStore.listByCase(id);
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
    return agentEventStore.listByCase(id);
  });

  app.get("/api/mcp/tools", async () => (mcp ? mcp.listTools() : []));

  app.get("/api/cases/:id/warnings", async (req) => {
    const { id } = req.params as { id: string };
    return observerStore.listByCase(id);
  });

  app.post("/api/cases/:id/scope/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { host } = (req.body ?? {}) as { host?: string };
    if (!host) return reply.code(400).send({ error: "host required" });
    const updated = cases.addAllowHost(id, host);
    if (!updated) return reply.code(404).send({ error: "case not found" });
    bus.emit({ type: "scope_updated", caseId: id, allowHosts: updated.scopeRules[0]?.allowHosts ?? [] });
    return updated;
  });

  const approvals = new ApprovalRegistry();
  const runs = new AgentRunRegistry();

  app.post("/api/cases/:id/agent/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });

    const { goal } = req.body as { goal: string };
    if (!goal?.trim()) return reply.code(400).send({ error: "goal required" });
    let active;
    try {
      active = runs.start(id, goal.trim());
    } catch (err) {
      return reply.code(409).send({ error: "active run exists", reason: (err as Error).message });
    }

    const runAgentInBackground = async (runId: string) => {
      const running = runs.get(runId);
      if (!running) return;
      const goal = running.run.goal;

    const registry = new ToolRegistry();
    registry.register(makeListTrafficTool(id, traffic));
    registry.register(makeGetTrafficTool(id, traffic));
    registry.register(makeRecordFactTool(id, factStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeRecordTaskTool(id, taskStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeRecordActionTool(id, factStore, actionStore, decisionStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeReopenTaskTool(id, taskStore, taskStore, factStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeRevertDoneTaskTool(id, taskStore, taskStore, factStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeHttpReplayTool(c.scopeRules));
    registry.register(makeProposeScopeExpansionTool((host, reason) =>
      bus.emit({ type: "scope_expansion_proposed", caseId: id, host, reason })));
    registry.register(makeUpdateSessionStateTool(id, sessionStore));
    registry.register(makeRecordHypothesisTool(id, hypothesisStore, factStore));
    registry.register(makeResolveHypothesisTool(id, hypothesisStore, factStore));
    registry.register(makeSearchFactsTool(id, factStore, { expander: queryExpander }));
    registry.register(makeGetFactDetailTool(id, factStore));
    registry.register(makeSearchTrafficTool(id, traffic));
    registry.register(makeRecallConversationTool(id, agentEventStore, contextSummaryStore, { expander: queryExpander }));

    // 若该 case 有共享浏览器会话，把浏览器工具纳入 agent 工具集
    const browserSession = browserSessions.get(id);
    if (browserSession) {
      for (const t of makeBrowserTools(browserSession, c.scopeRules)) registry.register(t);
    }

    // 若配置了 MCP server，把其工具（命名空间 mcp__<server>__<tool>）纳入 agent 工具集
    if (mcp) {
      for (const h of mcp.listTools()) registry.register(mcpToolToDescriptor(h, mcp));
    }

    const gate = new ApprovalGate(async (tool, input) => {
      const approvalId = `appr_${randomUUID()}`;
      bus.emit({ type: "approval_requested", caseId: id, approvalId, tool: tool.name, input: JSON.stringify(input) });
      const decision = await approvals.request(approvalId);
      bus.emit({ type: "approval_resolved", caseId: id, approvalId, decision });
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
你可以用工具查看流量、记录发现（Fact/Task/Action）、重放请求。证据驱动：记录动作前先记录支撑它的 Fact。
完成后用一句话总结。`;

    const trajectory: string[] = [];

    // 先取历史（此时不含当前 goal），构造近期对话
    const history = agentEventStore.listByCase(id);
    const recentConvo = history
      .filter((e) => e.kind === "user" || e.kind === "text" || e.kind === "done")
      .slice(-20)
      .map((e) => ({ role: e.kind === "user" ? ("user" as const) : ("assistant" as const), text: e.text }));
    const built = buildContext({
      goal,
      state: sessionStore.get(id),
      recentConvo,
      factCount: factStore.listByCase(id).length,
      trafficCount: traffic.listByCase(id).length,
      summaryCount: contextSummaryStore.latest(id) ? 1 : 0,
      activeHypotheses: hypothesisStore.listByCase(id).filter((h) => h.status === "open"),
      activeTasks: taskStore.listByCase(id).filter((t) => ["open", "blocked", "running", "recheck_candidate"].includes(t.status)),
      doneTaskSummaries: taskStore.listByCase(id).filter((t) => t.status === "done").map((t) => `${t.title}：${t.reason || "完成"}`),
      farSummary: contextSummaryStore.latest(id)?.content,
      scopeHosts: c.scopeRules.flatMap((r) => r.allowHosts),
    }, { maxTokens: 60000, focusReserve: 3000 });

    agentEventStore.append(id, "user", goal); // 存用户这句目标，刷新/切 Case 后历史可见完整双边对话
    agentEventStore.append(id, "started", `开始：${goal}`);
    await new AgentRuntime(llm, registry, gate).run(system, built.messages, (e) => {
      if (e.type === "tool_call") { bus.emit({ type: "agent_tool_call", caseId: id, tool: e.name ?? "", input: e.content }); agentEventStore.append(id, "tool_call", `${e.name}(${e.content})`, e.name ?? undefined); trajectory.push(`[tool] ${e.name}(${e.content})`); }
      else if (e.type === "tool_result") { bus.emit({ type: "agent_tool_result", caseId: id, tool: e.name ?? "", content: e.content }); agentEventStore.append(id, "tool_result", `${e.name} → ${e.content}`, e.name ?? undefined); trajectory.push(`[result] ${e.name} → ${e.content}`); }
      else if (e.type === "text") { bus.emit({ type: "agent_text", caseId: id, content: e.content }); agentEventStore.append(id, "text", e.content); trajectory.push(`[text] ${e.content}`); }
      else if (e.type === "done") { bus.emit({ type: "agent_done", caseId: id, content: e.content }); agentEventStore.append(id, "done", e.content); trajectory.push(`[done] ${e.content}`); }
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
      else if (e.type === "interrupted") {
        const interrupted = runs.markInterrupted(runId, running.run.interruptReason ?? e.content);
        if (interrupted) bus.emit({ type: "agent_run_interrupted", run: interrupted });
      }
    }, { signal: running.abortController.signal, runId, getSteeringMessages: () => runs.consumeSteering(runId) });

    const afterRun = runs.get(runId)?.run;
    if (afterRun && afterRun.status !== "interrupted") {
      const completed = runs.complete(runId);
      if (completed) bus.emit({ type: "agent_run_completed", run: completed, content: trajectory.at(-1) ?? "" });
    }

    timelineStore.append(id, "context_built", `注入 ${built.injectedFactIds.length} facts, ~${built.estimatedTokens} tokens, 降级:${built.degraded.join(",") || "无"}`);

    // 增量远期摘要：run 结束后压缩远期对话，失败不影响已完成的 run
    const FAR_THRESHOLD = 30;   // 超过此数量才压缩
    const RECENT_WINDOW = 20;   // 保留最近 N 条不压缩（近期）
    try {
      const allEvents = agentEventStore.listByCase(id);
      if (allEvents.length > FAR_THRESHOLD) {
        // 已摘要到第几条（用事件总数做游标，避免依赖 schema seq 字段）
        const alreadyCovered = contextSummaryStore.latest(id)?.coversUpToEventSeq ?? 0;
        // 远期窗口：[alreadyCovered, allEvents.length - RECENT_WINDOW)
        const farEndIdx = allEvents.length - RECENT_WINDOW;
        if (farEndIdx > alreadyCovered) {
          const farEvents = allEvents.slice(alreadyCovered, farEndIdx);
          const convoText = farEvents
            .filter((e) => e.kind === "user" || e.kind === "text" || e.kind === "done")
            .map((e) => `${e.kind === "user" ? "User" : "Agent"}: ${e.text}`)
            .join("\n");
          if (convoText.trim()) {
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

    // 旁路监督：run 结束后触发 Observer，失败不影响已完成的 run
    try {
      const factsSummary = factStore.listByCase(id).map((f) => `${f.id} [${f.type}] ${f.title}`).join("\n") || "(无)";
      const tasksSummary = taskStore.listByCase(id).map((t) => `${t.id} [${t.status}] ${t.title}`).join("\n") || "(无)";
      const warnings = await new Observer(llm).review(id, { goal, trajectory: trajectory.join("\n"), factsSummary, tasksSummary });
      for (const w of warnings) {
        observerStore.create(w);
        bus.emit({ type: "observer_warning", warning: w });
      }
    } catch (e) {
      console.error("[observer]", (e as Error).message);
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
    return { run };
  });

  app.get("/api/cases/:id/agent/runs/active", async (req) => {
    const { id } = req.params as { id: string };
    return runs.getActiveByCase(id)?.run ?? null;
  });

  app.post("/api/agent/approvals/:approvalId", async (req, reply) => {
    const { approvalId } = req.params as { approvalId: string };
    const { decision } = req.body as { decision: "approved" | "rejected" };
    const ok = approvals.resolve(approvalId, decision);
    if (!ok) return reply.code(404).send({ error: "approval not found" });
    return { ok: true };
  });
}
