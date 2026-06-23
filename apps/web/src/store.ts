import { create } from "zustand";
import type { TrafficEntry, Fact, Task, TimelineEntry, CandidateFact, ActionCard, Decision, RuntimeEvent } from "@traceforge/shared";

interface State {
  caseId: string | null;
  traffic: TrafficEntry[];
  facts: Fact[];
  tasks: Task[];
  timeline: TimelineEntry[];
  candidates: CandidateFact[];
  actionCandidates: ActionCard[];
  actions: ActionCard[];
  decisions: Decision[];
  setCase: (id: string) => void;
  addEntry: (e: TrafficEntry) => void;
  addFact: (f: Fact) => void;
  upsertTask: (t: Task) => void;
  addTimeline: (e: TimelineEntry) => void;
  setCandidates: (cs: CandidateFact[]) => void;
  removeCandidate: (id: string) => void;
  setActionCandidates: (cs: ActionCard[]) => void;
  removeActionCandidate: (id: string) => void;
  addAction: (a: ActionCard) => void;
  addDecision: (d: Decision) => void;
  connectWs: () => void;
}

export const useStore = create<State>((set, get) => ({
  caseId: null,
  traffic: [],
  facts: [],
  tasks: [],
  timeline: [],
  candidates: [],
  actionCandidates: [],
  actions: [],
  decisions: [],
  setCase: (id) => set({ caseId: id, traffic: [], facts: [], tasks: [], timeline: [], candidates: [], actionCandidates: [], actions: [], decisions: [] }),
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
  setCandidates: (cs) => set({ candidates: cs }),
  removeCandidate: (id) => set((s) => ({ candidates: s.candidates.filter((c) => c.id !== id) })),
  setActionCandidates: (cs) => set({ actionCandidates: cs }),
  removeActionCandidate: (id) => set((s) => ({ actionCandidates: s.actionCandidates.filter((c) => c.id !== id) })),
  addAction: (a) => set((s) => ({ actions: [...s.actions, a] })),
  addDecision: (d) => set((s) => ({ decisions: [...s.decisions, d] })),
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
      else if (event.type === "candidates_extracted" && event.caseId === cid) get().setCandidates(event.candidates);
      else if (event.type === "action_candidates_generated" && event.caseId === cid) get().setActionCandidates(event.candidates);
      else if (event.type === "action_approved" && event.action.caseId === cid) get().addAction(event.action);
      else if (event.type === "decision_recorded" && event.decision.caseId === cid) get().addDecision(event.decision);
    };
  },
}));
