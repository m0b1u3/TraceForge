import http from "node:http";
import { afterEach, describe, it, expect } from "vitest";
import { BrowserSession } from "./browser-session.js";
import { EventBus } from "./event-bus.js";
import { createDb } from "./db/client.js";
import { TrafficStore } from "./stores/traffic-store.js";
import type { ScopeRule, RuntimeEvent } from "@traceforge/shared";

const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }];

function makeSession(scopeRules: ScopeRule[] = rules, headless = false) {
  const db = createDb(":memory:");
  const bus = new EventBus();
  const events: RuntimeEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const traffic = new TrafficStore(db);
  const session = new BrowserSession("c", scopeRules, traffic, bus, { headless });
  return { session, events, traffic };
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

describe("BrowserSession traffic capture", () => {
  const sessions: BrowserSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.stop()));
  });

  it("captures real browser responses for approved host:port scope", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address unavailable");
      const allowedHost = `127.0.0.1:${address.port}`;
      const scopeRules: ScopeRule[] = [{ caseId: "c", allowHosts: [allowedHost], denyHosts: [] }];
      const { session, traffic, events } = makeSession(scopeRules, true);
      sessions.push(session);

      await session.start();
      await session.navigate(`http://${allowedHost}/login`);

      const entries = traffic.listByCase("c");
      expect(entries.some((entry) => entry.url === `http://${allowedHost}/login`)).toBe(true);
      expect(events.some((event) => event.type === "response_captured")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
