import { describe, expect, it } from "vitest";
import { AgentHarness } from "./index.js";

describe("AgentHarness", () => {
  it("owns the turn budget and returns a terminal session value", async () => {
    const turns: number[] = [];
    const session = new AgentHarness().openSession<string>("session", { maxTurns: 3 });
    const result = await session.run(1, new AbortController().signal, async (turn) => {
      turns.push(turn);
      return turn === 2 ? { outcome: "finished", value: "done" } : { outcome: "continue" };
    });
    expect(turns).toEqual([1, 2]);
    expect(result).toEqual({ outcome: "finished", value: "done" });
  });

  it("reports budget exhaustion without inventing a terminal result", async () => {
    const session = new AgentHarness().openSession("session", { maxTurns: 2 });
    await expect(session.run(1, new AbortController().signal, async () => ({ outcome: "continue" })))
      .resolves.toEqual({ outcome: "budget_exhausted", turns: 2 });
  });

  it("orders model intent, durable transcript recording, and observation", async () => {
    const events: string[] = [];
    const session = new AgentHarness().openSession("session", { maxTurns: 1 });
    const result = await session.evaluate({ context: { objective: "neutral" }, signal: new AbortController().signal,
      async decide(context) { events.push(`decide:${context.objective}`); return "intent"; },
      recordIntent(intent) { events.push(`record:${intent}`); },
      async observe(_context, intent) { events.push(`observe:${intent}`); return "continue"; },
    });
    expect(events).toEqual(["decide:neutral", "record:intent", "observe:intent"]);
    expect(result).toEqual({ intent: "intent", observation: "continue" });
  });

  it("classifies tool intents and applies generic observation failure policy", () => {
    const session = new AgentHarness().openSession("session", { maxTurns: 1 });
    expect(session.classifyToolIntent({ id: "first", name: "inspect" }, ["first"], true)).toBe("duplicate");
    expect(session.classifyToolIntent({ id: "second", name: "inspect" }, [], false)).toBe("unavailable");
    expect(session.classifyToolIntent({ id: "second", name: "inspect" }, [], true)).toBe("ready");
    expect(session.applyToolObservation("approval_required", 1, 2)).toEqual({ consecutiveFailures: 1,
      commitInvocation: false, requiresApproval: true, failureLimitReached: false });
    expect(session.applyToolObservation("failed", 1, 2)).toEqual({ consecutiveFailures: 2,
      commitInvocation: true, requiresApproval: false, failureLimitReached: true });
    expect(session.applyToolObservation("succeeded", 2, 3).consecutiveFailures).toBe(0);
  });
});
