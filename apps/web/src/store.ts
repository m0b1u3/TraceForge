import { create } from "zustand";
import type { TrafficEntry, Fact, Task, TimelineEntry, ActionCard, Decision, RuntimeEvent, Case, ObserverWarning, AgentRun } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";
import { listTraffic, listFacts, listTasks, listTimeline, listMcpTools, listWarnings, listAgentEvents, getLlmConfig, updateLlmConfig, testLlmConfig, deleteCase as deleteCaseApi, getActiveAgentRun, getLatestAgentRun, getPendingInterventions } from "./api.js";
import type { LlmConfig, LlmConfigInput } from "./api.js";

export interface AgentUiEvent {
  kind: "user" | "text" | "reasoning" | "tool_call" | "tool_result" | "done" | "error" | "started";
  text: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function isRunBusy(run: AgentRun | null): boolean {
  return run ? ["queued", "running", "interrupting"].includes(run.status) : false;
}

function runTokenUsage(run: AgentRun): TokenUsage {
  return {
    promptTokens: run.promptTokens,
    completionTokens: run.completionTokens,
    totalTokens: run.totalTokens,
  };
}

let disconnectActiveWebSocket: (() => void) | null = null;

interface State {
  caseId: string | null;
  traffic: TrafficEntry[];
  facts: Fact[];
  tasks: Task[];
  timeline: TimelineEntry[];
  actions: ActionCard[];
  decisions: Decision[];
  agentEvents: AgentUiEvent[];
  agentBusy: boolean;
  activeRun: AgentRun | null;
  continuationRun: AgentRun | null;
  streamingMessages: Record<string, number>;
  streamedAgentTexts: string[];
  tokenUsage: TokenUsage;
  setAgentBusy: (b: boolean) => void;
  setActiveRun: (run: AgentRun | null) => void;
  setContinuationRun: (run: AgentRun | null) => void;
  setTokenUsage: (usage: TokenUsage) => void;
  toast: string | null;
  showToast: (msg: string) => void;
  pendingApproval: { approvalId: string; tool: string; input: string } | null;
  browserController: "llm" | "human" | null;
  browserUrl: string;
  cases: Case[];
  activeTab: "facts" | "tasks" | "timeline" | "mcp" | "graph" | "observer";
  graphModalOpen: boolean;
  mcpTools: McpToolHandle[];
  warnings: ObserverWarning[];
  llmConfig: LlmConfig | null;
  settingsModalOpen: boolean;
  setLlmConfig: (cfg: LlmConfig | null) => void;
  setSettingsModalOpen: (open: boolean) => void;
  loadLlmConfig: () => Promise<void>;
  saveLlmConfig: (input: LlmConfigInput) => Promise<void>;
  testLlmConfig: (input: LlmConfigInput) => Promise<{ ok: boolean; message?: string; error?: string }>;
  addWarning: (w: ObserverWarning) => void;
  upsertWarning: (w: ObserverWarning) => void;
  pendingConfirmation: { runId: string; warning: ObserverWarning } | null;
  setPendingConfirmation: (p: { runId: string; warning: ObserverWarning }) => void;
  clearPendingConfirmation: () => void;
  pendingScope: { host: string; reason: string } | null;
  setPendingScope: (p: { host: string; reason: string } | null) => void;
  clearPendingScope: (host?: string) => void;
  setCase: (id: string | null) => void;
  setCases: (list: Case[]) => void;
  setActiveTab: (tab: State["activeTab"]) => void;
  setGraphModalOpen: (open: boolean) => void;
  enterCase: (id: string) => Promise<void>;
  deleteCase: (id: string) => Promise<void>;
  addEntry: (e: TrafficEntry) => void;
  addFact: (f: Fact) => void;
  upsertFact: (f: Fact) => void;
  upsertTask: (t: Task) => void;
  addTimeline: (e: TimelineEntry) => void;
  addAction: (a: ActionCard) => void;
  addDecision: (d: Decision) => void;
  addAgentEvent: (e: AgentUiEvent) => void;
  clearTraffic: () => void;
  setPendingApproval: (p: { approvalId: string; tool: string; input: string }) => void;
  clearPendingApproval: (approvalId?: string) => void;
  setBrowser: (controller: "llm" | "human" | null, url?: string) => void;
  resetBrowser: () => void;
  resetAgent: () => void;
  connectWs: () => () => void;
  handleRuntimeEvent: (event: RuntimeEvent) => void;
}

export const useStore = create<State>((set, get) => ({
  caseId: null,
  traffic: [],
  facts: [],
  tasks: [],
  timeline: [],
  actions: [],
  decisions: [],
  agentEvents: [],
  agentBusy: false,
  activeRun: null,
  continuationRun: null,
  streamingMessages: {},
  streamedAgentTexts: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  setAgentBusy: (b) => set({ agentBusy: b }),
  setActiveRun: (run) => set({ activeRun: run, agentBusy: isRunBusy(run) }),
  setContinuationRun: (run) => set({ continuationRun: run }),
  setTokenUsage: (usage) => set({ tokenUsage: usage }),
  toast: null,
  showToast: (msg) => { set({ toast: msg }); setTimeout(() => { if (get().toast === msg) set({ toast: null }); }, 4000); },
  pendingApproval: null,
  browserController: null,
  browserUrl: "",
  cases: [],
  activeTab: "facts",
  graphModalOpen: false,
  mcpTools: [],
  warnings: [],
  llmConfig: null,
  settingsModalOpen: false,
  setLlmConfig: (cfg) => set({ llmConfig: cfg }),
  setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),
  loadLlmConfig: async () => {
    try {
      const cfg = await getLlmConfig();
      set({ llmConfig: cfg });
    } catch (err) {
      get().showToast(`Failed to load settings: ${(err as Error).message}`);
    }
  },
  saveLlmConfig: async (input) => {
    try {
      const cfg = await updateLlmConfig(input);
      set({ llmConfig: cfg });
      get().showToast("Settings saved");
    } catch (err) {
      get().showToast(`Failed to save settings: ${(err as Error).message}`);
      throw err;
    }
  },
  testLlmConfig: async (input) => {
    try {
      const result = await testLlmConfig(input);
      if (result.ok) {
        get().showToast(result.message ?? "Connection successful");
      } else {
        get().showToast(`Connection failed: ${result.error ?? "unknown error"}`);
      }
      return result;
    } catch (err) {
      const message = `Connection test failed: ${(err as Error).message}`;
      get().showToast(message);
      return { ok: false, error: message };
    }
  },
  addWarning: (w) => set((s) => ({ warnings: [...s.warnings, w] })),
  upsertWarning: (w) =>
    set((s) => {
      const i = s.warnings.findIndex((x) => x.id === w.id);
      if (i === -1) return { warnings: [...s.warnings, w] };
      const copy = s.warnings.slice();
      copy[i] = w;
      return { warnings: copy };
    }),
  pendingConfirmation: null,
  setPendingConfirmation: (p) => set({ pendingConfirmation: p }),
  clearPendingConfirmation: () => set({ pendingConfirmation: null }),
  pendingScope: null,
  setPendingScope: (p) => set({ pendingScope: p }),
  clearPendingScope: (host) => set((s) => (
    !host || s.pendingScope?.host === host ? { pendingScope: null } : {}
  )),
  setCase: (id) => set({ caseId: id, traffic: [], facts: [], tasks: [], timeline: [], actions: [], decisions: [], agentEvents: [], agentBusy: false, activeRun: null, continuationRun: null, streamingMessages: {}, streamedAgentTexts: [], tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, pendingApproval: null, browserController: null, browserUrl: "", warnings: [], pendingScope: null, pendingConfirmation: null }),
  setCases: (list) => set({ cases: list }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setGraphModalOpen: (open) => set({ graphModalOpen: open }),
  enterCase: async (id) => {
    get().setCase(id);
    const [traffic, facts, tasks, timeline, mcpTools, warnings, agentEvents, activeRun, pendingInterventions] = await Promise.all([
      listTraffic(id), listFacts(id), listTasks(id), listTimeline(id), listMcpTools(), listWarnings(id), listAgentEvents(id), getActiveAgentRun(id), getPendingInterventions(id),
    ]);
    const latestRun = activeRun ?? await getLatestAgentRun(id);
    if (get().caseId !== id) return;
    set({
      traffic,
      facts,
      tasks,
      timeline,
      mcpTools,
      warnings,
      agentEvents: agentEvents.map((e) => ({ kind: e.kind, text: e.text })),
      activeRun,
      continuationRun: latestRun?.status === "needs_continuation" ? latestRun : null,
      agentBusy: isRunBusy(activeRun),
      tokenUsage: latestRun ? runTokenUsage(latestRun) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      pendingApproval: pendingInterventions.approval,
      pendingScope: pendingInterventions.scope,
    });
  },
  deleteCase: async (id) => {
    await deleteCaseApi(id);
    const isCurrent = get().caseId === id;
    set((s) => ({
      cases: s.cases.filter((c) => c.id !== id),
      ...(isCurrent
        ? {
            caseId: null,
            traffic: [],
            facts: [],
            tasks: [],
            timeline: [],
            actions: [],
            decisions: [],
            agentEvents: [],
            warnings: [],
            activeRun: null,
            agentBusy: false,
            browserController: null,
            browserUrl: "",
            pendingApproval: null,
            pendingScope: null,
            pendingConfirmation: null,
          }
        : {}),
    }));
    get().showToast("Case deleted");
  },
  addEntry: (e) => set((s) => ({ traffic: [...s.traffic, e] })),
  addFact: (f) => set((s) => ({ facts: [...s.facts, f] })),
  upsertFact: (f) =>
    set((s) => {
      const i = s.facts.findIndex((x) => x.id === f.id);
      if (i === -1) return { facts: [...s.facts, f] };
      const copy = s.facts.slice();
      copy[i] = f;
      return { facts: copy };
    }),
  upsertTask: (t) =>
    set((s) => {
      const i = s.tasks.findIndex((x) => x.id === t.id);
      if (i === -1) return { tasks: [...s.tasks, t] };
      const copy = s.tasks.slice();
      copy[i] = t;
      return { tasks: copy };
    }),
  addTimeline: (e) => set((s) => ({ timeline: [...s.timeline, e] })),
  addAction: (a) => set((s) => ({ actions: [...s.actions, a] })),
  addDecision: (d) => set((s) => ({ decisions: [...s.decisions, d] })),
  addAgentEvent: (e) => set((s) => ({ agentEvents: [...s.agentEvents, e] })),
  clearTraffic: () => set({ traffic: [] }),
  setPendingApproval: (p) => set({ pendingApproval: p }),
  clearPendingApproval: (approvalId) => set((s) => (
    !approvalId || s.pendingApproval?.approvalId === approvalId ? { pendingApproval: null } : {}
  )),
  setBrowser: (controller, url) => set((s) => ({ browserController: controller, browserUrl: url ?? s.browserUrl })),
  resetBrowser: () => set({ browserController: null, browserUrl: "" }),
  resetAgent: () => set({ agentEvents: [], pendingApproval: null, activeRun: null, continuationRun: null, streamingMessages: {}, streamedAgentTexts: [], agentBusy: false }),
  connectWs: () => {
    disconnectActiveWebSocket?.();

    let disposed = false;
    let retry = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const disconnect = () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = socket;
      socket = null;
      if (current && current.readyState < WebSocket.CLOSING) current.close();
      if (disconnectActiveWebSocket === disconnect) disconnectActiveWebSocket = null;
    };

    const open = () => {
      if (disposed) return;
      const ws = new WebSocket(`ws://${location.host}/ws`);
      socket = ws;
      ws.onopen = () => { retry = 0; };
      ws.onclose = () => {
        if (disposed || socket !== ws) return;
        const delay = Math.min(1000 * 2 ** retry, 10000);
        retry += 1;
        reconnectTimer = setTimeout(open, delay);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = onMessage;
    };
    const onMessage = (msg: MessageEvent) => {
      const event = JSON.parse(msg.data) as RuntimeEvent;
      get().handleRuntimeEvent(event);
    };
    disconnectActiveWebSocket = disconnect;
    open();
    return disconnect;
  },
  handleRuntimeEvent: (event) => {
    const cid = get().caseId;
    if (event.type === "response_captured" && event.entry.caseId === cid) get().addEntry(event.entry);
    else if (event.type === "fact_created" && event.fact.caseId === cid) get().addFact(event.fact);
    else if (event.type === "fact_updated" && event.fact.caseId === cid) get().upsertFact(event.fact);
    else if (event.type === "task_created" && event.task.caseId === cid) get().upsertTask(event.task);
    else if (event.type === "task_updated" && event.task.caseId === cid) get().upsertTask(event.task);
    else if (event.type === "timeline_appended" && event.entry.caseId === cid) get().addTimeline(event.entry);
    else if (event.type === "action_recorded" && event.action.caseId === cid) get().addAction(event.action);
    else if (event.type === "decision_recorded" && event.decision.caseId === cid) get().addDecision(event.decision);
    else if (event.type === "agent_run_started" && event.run.caseId === cid) {
      get().setActiveRun(event.run);
      get().setContinuationRun(null);
      get().setTokenUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      get().addAgentEvent({ kind: "started", text: `Started: ${event.run.goal}` });
    }
    else if (event.type === "agent_stream_start" && event.caseId === cid) {
      if (get().streamingMessages[event.messageId] !== undefined) return;
      set((s) => ({ streamingMessages: { ...s.streamingMessages, [event.messageId]: s.agentEvents.length } }));
      get().addAgentEvent({ kind: "text", text: "" });
    }
    else if (event.type === "agent_stream_delta" && event.caseId === cid) {
      set((s) => {
        const index = s.streamingMessages[event.messageId];
        if (index === undefined) return {};
        const events = s.agentEvents.slice();
        const cur = events[index];
        if (!cur) return {};
        events[index] = { ...cur, text: cur.text + event.delta };
        return { agentEvents: events };
      });
    }
    else if (event.type === "agent_stream_end" && event.caseId === cid) {
      set((s) => {
        const index = s.streamingMessages[event.messageId];
        if (index === undefined) return {};
        const { [event.messageId]: _done, ...rest } = s.streamingMessages;
        const events = s.agentEvents.slice();
        if (events[index]) events[index] = { ...events[index], text: event.content };
        return {
          agentEvents: events,
          streamingMessages: rest,
          streamedAgentTexts: event.content ? [...s.streamedAgentTexts, event.content] : s.streamedAgentTexts,
        };
      });
    }
    else if (event.type === "agent_retrying" && event.caseId === cid) {
      get().addAgentEvent({ kind: "text", text: `Retrying LLM call ${event.attempt}/${event.maxAttempts}: ${event.reason}` });
    }
    else if (event.type === "agent_steering_added" && event.caseId === cid) {
      const text = `[steering] ${event.content}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "user", text });
    }
    else if (event.type === "agent_run_completed" && event.run.caseId === cid) {
      get().setTokenUsage(runTokenUsage(event.run));
      get().setActiveRun(null);
      get().setContinuationRun(null);
      get().setAgentBusy(false);
    }
    else if (event.type === "agent_run_interrupted" && event.run.caseId === cid) {
      get().setTokenUsage(runTokenUsage(event.run));
      get().setActiveRun(null);
      get().setContinuationRun(null);
      get().setAgentBusy(false);
      get().addAgentEvent({ kind: "done", text: "Agent stopped" });
    }
    else if (event.type === "agent_run_needs_confirmation" && event.caseId === cid) {
      get().setPendingConfirmation({ runId: event.runId, warning: event.warning });
      get().setActiveTab("observer");
      const text = `[Observer] Critical: ${event.warning.title}`;
      get().addAgentEvent({ kind: "text", text });
      get().showToast(text);
    }
    else if (event.type === "agent_run_needs_continuation" && event.run.caseId === cid) {
      get().setTokenUsage(runTokenUsage(event.run));
      get().setActiveRun(null);
      get().setContinuationRun(event.run);
      get().setAgentBusy(false);
      get().addAgentEvent({ kind: "done", text: "Agent reached the run budget. Continue to proceed." });
    }
    else if (event.type === "agent_run_failed" && event.run.caseId === cid) {
      get().setTokenUsage(runTokenUsage(event.run));
      get().setActiveRun(null);
      get().setContinuationRun(null);
      get().setAgentBusy(false);
      get().addAgentEvent({ kind: "error", text: event.error });
    }
    else if (event.type === "agent_usage" && event.caseId === cid) {
      get().setTokenUsage({
        promptTokens: event.cumulativePromptTokens,
        completionTokens: event.cumulativeCompletionTokens,
        totalTokens: event.cumulativeTotalTokens,
      });
    }
    else if (event.type === "agent_started" && event.caseId === cid) {
      get().setAgentBusy(true);
      const text = `Started: ${event.goal}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "started", text });
    }
    else if (event.type === "agent_text" && event.caseId === cid) {
      const streamedIndex = get().streamedAgentTexts.indexOf(event.content);
      if (streamedIndex !== -1) {
        set((s) => ({ streamedAgentTexts: s.streamedAgentTexts.filter((_, index) => index !== streamedIndex) }));
        return;
      }
      const last = get().agentEvents.at(-1);
      if (!(last?.kind === "text" && last.text === event.content)) get().addAgentEvent({ kind: "text", text: event.content });
    }
    else if (event.type === "agent_reasoning" && event.caseId === cid) {
      const last = get().agentEvents.at(-1);
      if (!(last?.kind === "reasoning" && last.text === event.content)) get().addAgentEvent({ kind: "reasoning", text: event.content });
    }
    else if (event.type === "agent_tool_call" && event.caseId === cid) get().addAgentEvent({ kind: "tool_call", text: `${event.tool}(${event.input})` });
    else if (event.type === "agent_tool_result" && event.caseId === cid) get().addAgentEvent({ kind: "tool_result", text: `${event.tool} → ${event.content}` });
    else if (event.type === "agent_tool_blocked" && event.caseId === cid) get().addAgentEvent({ kind: "tool_result", text: `${event.tool} blocked → ${event.reason}\n${event.input}` });
    else if (event.type === "agent_done" && event.caseId === cid) { get().setAgentBusy(false); get().addAgentEvent({ kind: "done", text: event.content }); }
    else if (event.type === "agent_error" && event.caseId === cid) { get().setAgentBusy(false); get().addAgentEvent({ kind: "error", text: event.content }); }
    else if (event.type === "approval_requested" && event.caseId === cid) get().setPendingApproval({ approvalId: event.approvalId, tool: event.tool, input: event.input });
    else if (event.type === "approval_resolved" && event.caseId === cid) {
      const text = `Approval ${event.decision}: ${event.tool}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "done", text });
      get().clearPendingApproval(event.approvalId);
    }
    else if (event.type === "browser_started" && event.caseId === cid) get().setBrowser("llm");
    else if (event.type === "browser_stopped" && event.caseId === cid) get().resetBrowser();
    else if (event.type === "browser_control_changed" && event.caseId === cid) get().setBrowser(event.controller);
    else if (event.type === "browser_navigated" && event.caseId === cid) get().setBrowser(get().browserController, event.url);
    else if (event.type === "observer_warning" && event.warning.caseId === cid) get().addWarning(event.warning);
    else if (event.type === "observer_warning_updated" && event.warning.caseId === cid) get().upsertWarning(event.warning);
    else if (event.type === "scope_expansion_proposed" && event.caseId === cid) get().setPendingScope({ host: event.host, reason: event.reason });
    else if (event.type === "scope_expansion_rejected" && event.caseId === cid) {
      const text = `Scope kept blocked: ${event.host}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "done", text });
      get().clearPendingScope(event.host);
    }
    else if (event.type === "scope_updated" && event.caseId === cid) {
      const pending = get().pendingScope;
      if (pending && event.allowHosts.includes(pending.host)) {
        const text = `Scope approved: ${pending.host}`;
        if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "done", text });
        get().clearPendingScope(pending.host);
      }
    }
    else if (event.type === "case_deleted" && event.caseId === cid) {
      get().showToast("This case has been deleted");
      get().setCase(null);
    }
  },
}));
