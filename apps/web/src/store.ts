import { create } from "zustand";
import type { TrafficEntry, Fact, Task, TimelineEntry, ActionCard, Decision, RuntimeEvent } from "@traceforge/shared";

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
  setCase: (id: string) => void;
  addEntry: (e: TrafficEntry) => void;
  addFact: (f: Fact) => void;
  upsertTask: (t: Task) => void;
  addTimeline: (e: TimelineEntry) => void;
  addAction: (a: ActionCard) => void;
  addDecision: (d: Decision) => void;
  addAgentEvent: (e: AgentUiEvent) => void;
  setPendingApproval: (p: { approvalId: string; tool: string; input: string }) => void;
  clearPendingApproval: () => void;
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
  setCase: (id) => set({ caseId: id, traffic: [], facts: [], tasks: [], timeline: [], actions: [], decisions: [], agentEvents: [], pendingApproval: null }),
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
    };
  },
}));
