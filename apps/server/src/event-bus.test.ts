import { describe, it, expect } from "vitest";
import { EventBus } from "./event-bus.js";

describe("EventBus", () => {
  it("delivers emitted events to subscribers", () => {
    const bus = new EventBus();
    const calls: unknown[] = [];
    const fn = (event: unknown) => { calls.push(event); };
    bus.subscribe(fn);
    bus.emit({ type: "scope_violation", caseId: "c1", url: "http://x", reason: "out of scope" });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { type: string }).type).toBe("scope_violation");
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    const calls: unknown[] = [];
    const fn = (event: unknown) => { calls.push(event); };
    const off = bus.subscribe(fn);
    off();
    bus.emit({ type: "scope_violation", caseId: "c1", url: "http://x", reason: "r" });
    expect(calls).toHaveLength(0);
  });
});
