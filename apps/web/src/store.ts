import { create } from "zustand";
import type { TrafficEntry, Fact, Task, TimelineEntry, ActionCard, Decision, RuntimeEvent, Case, ObserverWarning, AgentRun } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";
import { listTraffic, listFacts, listTasks, listTimeline, listMcpTools, listWarnings, listAgentEvents } from "./api.js";

export interface AgentUiEvent {
  kind: "user" | "text" | "tool_call" | "tool_result" | "done" | "error" | "started";
  text: string;
}

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
  streamingMessages: Record<string, number>;
  setAgentBusy: (b: boolean) => void;
  setActiveRun: (run: AgentRun | null) => void;
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
  addWarning: (w: ObserverWarning) => void;
  pendingScope: { host: string; reason: string } | null;
  setPendingScope: (p: { host: string; reason: string } | null) => void;
  setCase: (id: string) => void;
  setCases: (list: Case[]) => void;
  setActiveTab: (tab: State["activeTab"]) => void;
  setGraphModalOpen: (open: boolean) => void;
  enterCase: (id: string) => Promise<void>;
  addEntry: (e: TrafficEntry) => void;
  addFact: (f: Fact) => void;
  upsertFact: (f: Fact) => void;
  upsertTask: (t: Task) => void;
  addTimeline: (e: TimelineEntry) => void;
  addAction: (a: ActionCard) => void;
  addDecision: (d: Decision) => void;
  addAgentEvent: (e: AgentUiEvent) => void;
  setPendingApproval: (p: { approvalId: string; tool: string; input: string }) => void;
  clearPendingApproval: () => void;
  setBrowser: (controller: "llm" | "human" | null, url?: string) => void;
  resetBrowser: () => void;
  resetAgent: () => void;
  connectWs: () => void;
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
  streamingMessages: {},
  setAgentBusy: (b) => set({ agentBusy: b }),
  setActiveRun: (run) => set({ activeRun: run, agentBusy: run ? ["queued", "running", "interrupting"].includes(run.status) : false }),
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
  addWarning: (w) => set((s) => ({ warnings: [...s.warnings, w] })),
  pendingScope: null,
  setPendingScope: (p) => set({ pendingScope: p }),
  setCase: (id) => set({ caseId: id, traffic: [], facts: [], tasks: [], timeline: [], actions: [], decisions: [], agentEvents: [], agentBusy: false, activeRun: null, streamingMessages: {}, pendingApproval: null, browserController: null, browserUrl: "", warnings: [], pendingScope: null }),
  setCases: (list) => set({ cases: list }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setGraphModalOpen: (open) => set({ graphModalOpen: open }),
  enterCase: async (id) => {
    get().setCase(id);
    const [traffic, facts, tasks, timeline, mcpTools, warnings, agentEvents] = await Promise.all([
      listTraffic(id), listFacts(id), listTasks(id), listTimeline(id), listMcpTools(), listWarnings(id), listAgentEvents(id),
    ]);
    set({ traffic, facts, tasks, timeline, mcpTools, warnings, agentEvents: agentEvents.map((e) => ({ kind: e.kind, text: e.text })) });
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
  setPendingApproval: (p) => set({ pendingApproval: p }),
  clearPendingApproval: () => set({ pendingApproval: null }),
  setBrowser: (controller, url) => set((s) => ({ browserController: controller, browserUrl: url ?? s.browserUrl })),
  resetBrowser: () => set({ browserController: null, browserUrl: "" }),
  resetAgent: () => set({ agentEvents: [], pendingApproval: null, activeRun: null, streamingMessages: {}, agentBusy: false }),
  connectWs: () => {
    // 带自动重连：后端重启 / 网络抖动后，WS 会重新建立，否则所有实时更新会静默失效。
    let retry = 0;
    const open = () => {
      const ws = new WebSocket(`ws://${location.host}/ws`);
      ws.onopen = () => { retry = 0; };
      ws.onclose = () => {
        const delay = Math.min(1000 * 2 ** retry, 10000); // 退避，封顶 10s
        retry += 1;
        setTimeout(open, delay);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = onMessage;
    };
    const onMessage = (msg: MessageEvent) => {
      const event = JSON.parse(msg.data) as RuntimeEvent;
      get().handleRuntimeEvent(event);
    };
    open();
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
      get().addAgentEvent({ kind: "started", text: `开始：${event.run.goal}` });
    }
    else if (event.type === "agent_stream_start" && event.caseId === cid) {
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
        const { [event.messageId]: _done, ...rest } = s.streamingMessages;
        return { streamingMessages: rest };
      });
    }
    else if (event.type === "agent_retrying" && event.caseId === cid) {
      get().addAgentEvent({ kind: "text", text: `正在重试 LLM 调用 ${event.attempt}/${event.maxAttempts}：${event.reason}` });
    }
    else if (event.type === "agent_steering_added" && event.caseId === cid) {
      const text = `[steering] ${event.content}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "user", text });
    }
    else if (event.type === "agent_run_completed" && event.run.caseId === cid) {
      get().setActiveRun(null);
      get().setAgentBusy(false);
    }
    else if (event.type === "agent_run_interrupted" && event.run.caseId === cid) {
      get().setActiveRun(null);
      get().setAgentBusy(false);
      get().addAgentEvent({ kind: "done", text: "Agent 已停止" });
    }
    else if (event.type === "agent_run_failed" && event.run.caseId === cid) {
      get().setActiveRun(null);
      get().setAgentBusy(false);
      get().addAgentEvent({ kind: "error", text: event.error });
    }
    else if (event.type === "agent_started" && event.caseId === cid) {
      get().setAgentBusy(true);
      const text = `开始：${event.goal}`;
      if (get().agentEvents.at(-1)?.text !== text) get().addAgentEvent({ kind: "started", text });
    }
    else if (event.type === "agent_text" && event.caseId === cid) {
      const last = get().agentEvents.at(-1);
      if (!(last?.kind === "text" && last.text === event.content)) get().addAgentEvent({ kind: "text", text: event.content });
    }
    else if (event.type === "agent_tool_call" && event.caseId === cid) get().addAgentEvent({ kind: "tool_call", text: `${event.tool}(${event.input})` });
    else if (event.type === "agent_tool_result" && event.caseId === cid) get().addAgentEvent({ kind: "tool_result", text: `${event.tool} → ${event.content}` });
    else if (event.type === "agent_done" && event.caseId === cid) { get().setAgentBusy(false); get().addAgentEvent({ kind: "done", text: event.content }); }
    else if (event.type === "agent_error" && event.caseId === cid) { get().setAgentBusy(false); get().addAgentEvent({ kind: "error", text: event.content }); }
    else if (event.type === "approval_requested" && event.caseId === cid) get().setPendingApproval({ approvalId: event.approvalId, tool: event.tool, input: event.input });
    else if (event.type === "approval_resolved" && event.caseId === cid) get().clearPendingApproval();
    else if (event.type === "browser_started" && event.caseId === cid) get().setBrowser("llm");
    else if (event.type === "browser_stopped" && event.caseId === cid) get().resetBrowser();
    else if (event.type === "browser_control_changed" && event.caseId === cid) get().setBrowser(event.controller);
    else if (event.type === "browser_navigated" && event.caseId === cid) get().setBrowser(get().browserController, event.url);
    else if (event.type === "observer_warning" && event.warning.caseId === cid) get().addWarning(event.warning);
    else if (event.type === "scope_expansion_proposed" && event.caseId === cid) get().setPendingScope({ host: event.host, reason: event.reason });
    else if (event.type === "scope_updated" && event.caseId === cid) get().setPendingScope(null);
  },
}));
