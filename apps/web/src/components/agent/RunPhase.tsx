import { Check, Circle, CircleNotch, LockSimple } from "@phosphor-icons/react";
import type { AgentUiEvent } from "../../store.js";

export type RunPhaseKey = "scoping" | "discovering" | "capturing" | "analyzing" | "validating" | "reporting";
const PHASES: readonly { key: RunPhaseKey; label: string }[] = [
  { key: "scoping", label: "Scope" }, { key: "discovering", label: "Discover" },
  { key: "capturing", label: "Capture" }, { key: "analyzing", label: "Analyze" },
  { key: "validating", label: "Validate" }, { key: "reporting", label: "Report" },
];

export function deriveRunPhase(input: { events: AgentUiEvent[]; trafficCount: number; factCount: number; busy: boolean }): RunPhaseKey {
  const last = input.events.at(-1);
  if (last?.kind === "done") return "reporting";
  if (input.factCount > 0) return "validating";
  if (last?.kind === "reasoning" || last?.kind === "tool_result") return "analyzing";
  if (input.trafficCount > 0) return "capturing";
  if (last?.kind === "tool_call" || input.busy) return "discovering";
  return "scoping";
}

export function RunPhase({ phase, blocked, active }: { phase: RunPhaseKey; blocked: boolean; active: boolean }) {
  const activeIndex = PHASES.findIndex((item) => item.key === phase);
  return <div className={`run-phase ${blocked ? "is-blocked" : ""} ${active ? "is-running" : "is-idle"}`} aria-label={blocked ? "Agent run blocked for review" : `Agent run phase: ${phase}`}>
    {PHASES.map((item, index) => <div className={`run-phase-step ${index === activeIndex ? "is-active" : ""} ${index < activeIndex ? "is-complete" : ""}`} key={item.key}>
      {index < activeIndex ? <Check size={11} weight="bold" /> : index === activeIndex && active && !blocked ? <CircleNotch size={11} className="tf-spin" /> : blocked && index === activeIndex ? <LockSimple size={11} /> : <Circle size={8} />}
      <span>{item.label}</span>
    </div>)}
  </div>;
}
