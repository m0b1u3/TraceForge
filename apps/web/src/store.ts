import { create } from "zustand";
import type { TrafficEntry, Fact, Task, TimelineEntry, ActionCard, Decision, RuntimeEvent, Case, ObserverWarning } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";
import { listTraffic, listFacts, listTasks, listTimeline, listMcpTools, listWarnings } from "./api.js";

export interface AgentUiEvent {
  kind: "text" | "tool_call" | "tool_result" | "done" | "error" | "started";
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
  pendingApproval: { approvalId: string; tool: string; input: string } | null;
  browserController: "llm" | "human" | null;
  browserUrl: string;
  cases: Case[];
  activeTab: "facts" | "tasks" | "timeline" | "mcp" | "graph" | "observer";
  graphModalOpen: boolean;
  mcpTools: McpToolHandle[];
  warnings: ObserverWarning[];
  addWarning: (w: ObserverWarning) => void;
  setCase: (id: string) => void;
  setCases: (list: Case[]) => void;
  setActiveTab: (tab: State["activeTab"]) => void;
  setGraphModalOpen: (open: boolean) => void;
  enterCase: (id: string) => Promise<void>;
  addEntry: (e: TrafficEntry) => void;
  addFact: (f: Fact) => void;
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
  pendingApproval: null,
  browserController: null,
  browserUrl: "",
  cases: [],
  activeTab: "facts",
  graphModalOpen: false,
  mcpTools: [],
  warnings: [],
  addWarning: (w) => set((s) => ({ warnings: [...s.warnings, w] })),
  setCase: (id) => set({ caseId: id, traffic: [], facts: [], tasks: [], timeline: [], actions: [], decisions: [], agentEvents: [], pendingApproval: null, browserController: null, browserUrl: "", warnings: [] }),
  setCases: (list) => set({ cases: list }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setGraphModalOpen: (open) => set({ graphModalOpen: open }),
  enterCase: async (id) => {
    get().setCase(id);
    const [traffic, facts, tasks, timeline, mcpTools, warnings] = await Promise.all([
      listTraffic(id), listFacts(id), listTasks(id), listTimeline(id), listMcpTools(), listWarnings(id),
    ]);
    set({ traffic, facts, tasks, timeline, mcpTools, warnings });
  },
  addEntry: (e) => set((s) => ({ traffic: [...s.traffic, e] })),
  addFact: (f) => set((s) => ({ facts: [...s.facts, f] })),
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
  resetAgent: () => set({ agentEvents: [], pendingApproval: null }),
  connectWs: () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as RuntimeEvent;
      const cid = get().caseId;
      if (event.type === "response_captured" && event.entry.caseId === cid) get().addEntry(event.entry);
      else if (event.type === "fact_created" && event.fact.caseId === cid) get().addFact(event.fact);
      else if (event.type === "task_created" && event.task.caseId === cid) get().upsertTask(event.task);
      else if (event.type === "task_updated" && event.task.caseId === cid) get().upsertTask(event.task);
      else if (event.type === "timeline_appended" && event.entry.caseId === cid) get().addTimeline(event.entry);
      else if (event.type === "action_recorded" && event.action.caseId === cid) get().addAction(event.action);
      else if (event.type === "decision_recorded" && event.decision.caseId === cid) get().addDecision(event.decision);
      else if (event.type === "agent_started" && event.caseId === cid) get().addAgentEvent({ kind: "started", text: `开始：${event.goal}` });
      else if (event.type === "agent_text" && event.caseId === cid) get().addAgentEvent({ kind: "text", text: event.content });
      else if (event.type === "agent_tool_call" && event.caseId === cid) get().addAgentEvent({ kind: "tool_call", text: `${event.tool}(${event.input})` });
      else if (event.type === "agent_tool_result" && event.caseId === cid) get().addAgentEvent({ kind: "tool_result", text: `${event.tool} → ${event.content}` });
      else if (event.type === "agent_done" && event.caseId === cid) get().addAgentEvent({ kind: "done", text: event.content });
      else if (event.type === "agent_error" && event.caseId === cid) get().addAgentEvent({ kind: "error", text: event.content });
      else if (event.type === "approval_requested" && event.caseId === cid) get().setPendingApproval({ approvalId: event.approvalId, tool: event.tool, input: event.input });
      else if (event.type === "approval_resolved" && event.caseId === cid) get().clearPendingApproval();
      else if (event.type === "browser_started" && event.caseId === cid) get().setBrowser("llm");
      else if (event.type === "browser_stopped" && event.caseId === cid) get().resetBrowser();
      else if (event.type === "browser_control_changed" && event.caseId === cid) get().setBrowser(event.controller);
      else if (event.type === "browser_navigated" && event.caseId === cid) get().setBrowser(get().browserController, event.url);
      else if (event.type === "observer_warning" && event.warning.caseId === cid) get().addWarning(event.warning);
    };
  },
}));
