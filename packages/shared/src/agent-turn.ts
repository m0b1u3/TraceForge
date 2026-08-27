import { z } from "zod";

export const AgentTurnPhaseSchema = z.enum([
  "prepared",
  "contextBuilt",
  "modelInvoked",
  "decisionProduced",
  "actionRequested",
  "toolExecuted",
  "observationApplied",
  "checkpointed",
]);
export type AgentTurnPhase = z.infer<typeof AgentTurnPhaseSchema>;

export const AgentTurnOutcomeSchema = z.enum(["continue", "finish", "waitingApproval", "blocked"]);
export type AgentTurnOutcome = z.infer<typeof AgentTurnOutcomeSchema>;

const nextPhases: Record<AgentTurnPhase, readonly AgentTurnPhase[]> = {
  prepared: ["contextBuilt"],
  contextBuilt: ["modelInvoked"],
  modelInvoked: ["decisionProduced"],
  decisionProduced: ["actionRequested", "observationApplied", "checkpointed"],
  actionRequested: ["toolExecuted"],
  toolExecuted: ["observationApplied"],
  observationApplied: ["checkpointed"],
  checkpointed: [],
};

export function assertAgentTurnTransition(previous: AgentTurnPhase | null, next: AgentTurnPhase): void {
  if (previous === null) {
    if (next !== "prepared") throw new Error(`Agent Turn must start at prepared, not ${next}`);
    return;
  }
  if (!nextPhases[previous].includes(next)) throw new Error(`Invalid Agent Turn transition ${previous} -> ${next}`);
}

export function assertAgentTurnCanComplete(phase: AgentTurnPhase, outcome: AgentTurnOutcome): void {
  if (phase !== "decisionProduced" && phase !== "checkpointed") throw new Error(`Agent Turn cannot complete from ${phase}`);
  if (phase === "decisionProduced" && outcome === "continue") {
    throw new Error("A continuing Agent Turn must checkpoint its observation before completion");
  }
}
