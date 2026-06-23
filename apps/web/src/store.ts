import { create } from "zustand";
import type { TrafficEntry, RuntimeEvent } from "@traceforge/shared";

interface State {
  caseId: string | null;
  traffic: TrafficEntry[];
  setCase: (id: string) => void;
  addEntry: (e: TrafficEntry) => void;
  connectWs: () => void;
}

export const useStore = create<State>((set, get) => ({
  caseId: null,
  traffic: [],
  setCase: (id) => set({ caseId: id, traffic: [] }),
  addEntry: (e) => set((s) => ({ traffic: [...s.traffic, e] })),
  connectWs: () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as RuntimeEvent;
      if (event.type === "response_captured" && event.entry.caseId === get().caseId) {
        get().addEntry(event.entry);
      }
    };
  },
}));
