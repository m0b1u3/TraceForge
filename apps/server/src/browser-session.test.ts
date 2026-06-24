import { describe, it, expect } from "vitest";
import { BrowserSession } from "./browser-session.js";
import { EventBus } from "./event-bus.js";
import { createDb } from "./db/client.js";
import { TrafficStore } from "./stores/traffic-store.js";
import type { ScopeRule, RuntimeEvent } from "@traceforge/shared";

const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }];

function makeSession() {
  const db = createDb(":memory:");
  const bus = new EventBus();
  const events: RuntimeEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const session = new BrowserSession("c", rules, new TrafficStore(db), bus);
  return { session, events };
}

describe("BrowserSession control lock", () => {
  it("defaults to llm control", () => {
    const { session } = makeSession();
    expect(session.controllerIs("llm")).toBe(true);
    expect(session.controllerIs("human")).toBe(false);
  });

  it("human takeover flips control and emits event", () => {
    const { session, events } = makeSession();
    session.acquireByHuman();
    expect(session.controllerIs("human")).toBe(true);
    expect(events.some((e) => e.type === "browser_control_changed" && e.controller === "human")).toBe(true);
  });

  it("release returns control to llm", () => {
    const { session, events } = makeSession();
    session.acquireByHuman();
    session.releaseToLlm();
    expect(session.controllerIs("llm")).toBe(true);
    expect(events.some((e) => e.type === "browser_control_changed" && e.controller === "llm")).toBe(true);
  });
});
