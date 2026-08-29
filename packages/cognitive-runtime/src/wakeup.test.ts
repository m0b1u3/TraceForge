import { describe, expect, it, vi } from "vitest";
import {
  BlackboardChangeBus,
  CognitiveWakeGate,
  type CognitiveContextCursorAdvance,
  type CognitiveContextCursorPort,
} from "./wakeup.js";

const at = "2026-08-28T03:00:00.000Z";

class MemoryCursorPort implements CognitiveContextCursorPort {
  readonly values = new Map<string, string>();
  readonly advances: CognitiveContextCursorAdvance[] = [];

  cursor(consumer: string, runId: string): string | undefined {
    return this.values.get(`${consumer}:${runId}`);
  }

  advance(input: CognitiveContextCursorAdvance): void {
    this.advances.push(input);
    this.values.set(`${input.consumer}:${input.runId}`, input.semanticFingerprint);
  }
}

describe("BlackboardChangeBus", () => {
  it("publishes committed change hints without allowing one listener to block another", () => {
    const bus = new BlackboardChangeBus();
    const observed = vi.fn();
    bus.subscribe(() => { throw new Error("listener unavailable"); });
    bus.subscribe(observed);
    const change = {
      kind: "run" as const,
      runId: "first_run",
      caseId: "first_case",
      revision: 2,
      eventTypes: ["first_event"],
      at,
    };

    expect(() => bus.publish(change)).not.toThrow();
    expect(observed).toHaveBeenCalledWith(change);
  });

  it("removes subscriptions deterministically", () => {
    const bus = new BlackboardChangeBus();
    const observed = vi.fn();
    const unsubscribe = bus.subscribe(observed);
    expect(bus.listenerCount()).toBe(1);
    unsubscribe();
    bus.publish({ kind: "graph", caseId: "first_case", revision: 1, eventTypes: [], at });
    expect(bus.listenerCount()).toBe(0);
    expect(observed).not.toHaveBeenCalled();
  });
});

describe("CognitiveWakeGate", () => {
  it("uses an isolated volatile cursor when no persistence adapter is installed", () => {
    const gate = new CognitiveWakeGate();
    expect(gate.shouldEvaluate("observer", "first_run", "first_state")).toBe(true);
    gate.advance({
      consumer: "observer",
      runId: "first_run",
      semanticFingerprint: "first_state",
      sourceRunRevision: 2,
      sourceGraphRevision: 3,
      at,
    });
    expect(gate.shouldEvaluate("observer", "first_run", "first_state")).toBe(false);
    expect(gate.shouldEvaluate("planner", "first_run", "first_state")).toBe(true);
    expect(gate.shouldEvaluate("observer", "second_run", "first_state")).toBe(true);
    expect(gate.shouldEvaluate("observer", "first_run", "second_state")).toBe(true);
  });

  it("delegates durable cursor reads and advances through the port", () => {
    const cursors = new MemoryCursorPort();
    cursors.values.set("observer:first_run", "first_state");
    const gate = new CognitiveWakeGate(cursors);
    expect(gate.shouldEvaluate("observer", "first_run", "first_state")).toBe(false);
    gate.advance({
      consumer: "observer",
      runId: "first_run",
      semanticFingerprint: "second_state",
      sourceRunRevision: 4,
      sourceGraphRevision: 5,
      at,
    });
    expect(cursors.advances).toHaveLength(1);
    expect(gate.shouldEvaluate("observer", "first_run", "second_state")).toBe(false);
  });
});
