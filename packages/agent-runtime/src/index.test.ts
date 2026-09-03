import { describe, expect, it } from "vitest";
import { AgentHarness, createAgentExecutionJournal, migrateLegacyAgentExecutionJournal,
  recordAgentJournalTerminal, resumeAgentExecutionJournal, validateAgentExecutionJournal } from "./index.js";

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

  it("creates and migrates a bounded, versioned execution journal", () => {
    const created = createAgentExecutionJournal({ sessionId: "agent:run/work",
      initialEntries: [{ turn: 0, kind: "system", summary: "Started", refs: ["scope:first"] }] });
    expect(created).toMatchObject({ format: "traceforge-agent-execution-journal", version: 1, turn: 0, terminal: null });
    const migrated = migrateLegacyAgentExecutionJournal({ sessionId: "agent:run/work", turn: 2, consecutiveFailures: 1,
      transcript: [{ turn: 1, kind: "tool", summary: "Observed", refs: ["receipt:first"], receiptKey: "effect:first" }],
      steering: ["Continue"], completedInvocationIds: ["first"] });
    expect(migrated).toMatchObject({ turn: 2, consecutiveFailures: 1, completedIntentIds: ["first"] });
  });

  it("rejects corrupt, ambiguous, or unbounded journal state", () => {
    const journal = createAgentExecutionJournal({ sessionId: "agent:run/work" });
    expect(() => validateAgentExecutionJournal({ ...journal, completedIntentIds: ["same", "same"] })).toThrow("Invalid");
    expect(() => validateAgentExecutionJournal({ ...journal, terminal: { outcome: "blocked", reason: "reason", turn: 1 } })).toThrow("terminal");
    expect(() => validateAgentExecutionJournal({ ...journal, steering: Array.from({ length: 1025 }, () => "next") })).toThrow("Invalid");
  });

  it("records terminal decisions idempotently and only resumes non-completed work", () => {
    const journal = createAgentExecutionJournal({ sessionId: "agent:run/work" });
    const terminal = { outcome: "blocked" as const, reason: "Needs review", turn: 0 };
    expect(recordAgentJournalTerminal(journal, terminal).terminal).toEqual(terminal);
    expect(recordAgentJournalTerminal(journal, terminal).terminal).toEqual(terminal);
    expect(() => recordAgentJournalTerminal(journal, { ...terminal, reason: "Changed" })).toThrow("different terminal");
    expect(resumeAgentExecutionJournal(journal).terminal).toBeNull();
    recordAgentJournalTerminal(journal, { outcome: "completed", reason: "Done", turn: 0 });
    expect(() => resumeAgentExecutionJournal(journal)).toThrow("cannot resume");
  });
});
