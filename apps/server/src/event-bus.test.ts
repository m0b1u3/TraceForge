import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./event-bus.js";

describe("EventBus", () => {
  it("delivers emitted events to subscribers", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    bus.emit({ type: "scope_violation", caseId: "c1", url: "http://x", reason: "out of scope" });
    expect(fn).toHaveBeenCalledOnce();
    expect(fn.mock.calls[0][0].type).toBe("scope_violation");
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    off();
    bus.emit({ type: "scope_violation", caseId: "c1", url: "http://x", reason: "r" });
    expect(fn).not.toHaveBeenCalled();
  });
});
