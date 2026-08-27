import { describe, expect, it } from "vitest";
import { assertAgentTurnCanComplete, assertAgentTurnTransition, type AgentTurnPhase } from "./agent-turn.js";

describe("Agent Turn lifecycle contract", () => {
  it("accepts the full action and observation lifecycle", () => {
    const phases: AgentTurnPhase[] = [
      "prepared", "contextBuilt", "modelInvoked", "decisionProduced",
      "actionRequested", "toolExecuted", "observationApplied", "checkpointed",
    ];
    let previous: AgentTurnPhase | null = null;
    for (const phase of phases) {
      expect(() => assertAgentTurnTransition(previous, phase)).not.toThrow();
      previous = phase;
    }
    expect(() => assertAgentTurnCanComplete("checkpointed", "continue")).not.toThrow();
  });

  it("rejects skipped execution phases and uncheckpointed continuation", () => {
    expect(() => assertAgentTurnTransition("decisionProduced", "toolExecuted")).toThrow(/Invalid Agent Turn transition/);
    expect(() => assertAgentTurnCanComplete("decisionProduced", "continue")).toThrow(/must checkpoint/);
  });
});
