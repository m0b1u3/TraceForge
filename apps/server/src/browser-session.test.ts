import http from "node:http";
import { afterEach, describe, it, expect } from "vitest";
import { BrowserSession } from "./browser-session.js";
import { EventBus } from "./event-bus.js";
import { createDb } from "./db/client.js";
import { TrafficStore } from "./stores/traffic-store.js";
import type { Browser, Page } from "playwright";
import type { ScopeRule, RuntimeEvent } from "@traceforge/shared";

const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }];

function makeSession(scopeRules: ScopeRule[] = rules, headless = false, onStopped?: () => void) {
  const db = createDb(":memory:");
  const bus = new EventBus();
  const events: RuntimeEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const traffic = new TrafficStore(db);
  const session = new BrowserSession("c", scopeRules, traffic, bus, { headless }, onStopped);
  return { session, events, traffic };
}

describe("BrowserSession control lock", () => {
  it("defaults to llm control", () => {
    const { session } = makeSession();
    expect(session.controllerIs("llm")).toBe(true);
    expect(session.controllerIs("human")).toBe(false);
  });

  it("human takeover flips control and emits event", async () => {
    const { session, events } = makeSession();
    await session.acquireByHuman();
    expect(session.controllerIs("human")).toBe(true);
    expect(events.some((e) => e.type === "browser_control_changed" && e.controller === "human")).toBe(true);
  });

  it("release returns control to llm", async () => {
    const { session, events } = makeSession();
    await session.acquireByHuman();
    await session.releaseToLlm();
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
      expect(entries.filter((entry) => entry.url === `http://${allowedHost}/login`)).toHaveLength(1);
      expect(events.filter((event) => event.type === "response_captured")).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("captures evidence from human navigation without granting Agent scope", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<button id='target' onclick='window.clicks=(window.clicks||0)+1'>target</button>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address unavailable");
      const visitedUrl = `http://127.0.0.1:${address.port}/outside-agent-scope`;
      const { session, traffic } = makeSession(rules, true);
      sessions.push(session);

      await session.start();
      const page = Reflect.get(session, "page") as Page;
      await page.goto(visitedUrl);

      expect(traffic.listByCase("c").some((entry) => entry.url === visitedUrl)).toBe(true);
      await expect(session.navigate(visitedUrl)).resolves.toMatchObject({ ok: false });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("locks human page input while LLM owns control and unlocks on takeover", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<button id='target' onclick='window.clicks=(window.clicks||0)+1'>target</button>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address unavailable");
      const allowedHost = `127.0.0.1:${address.port}`;
      const scopeRules: ScopeRule[] = [{ caseId: "c", allowHosts: [allowedHost], denyHosts: [] }];
      const { session } = makeSession(scopeRules, true);
      sessions.push(session);
      await session.start();
      await session.navigate(`http://${allowedHost}/`);
      const page = Reflect.get(session, "page") as Page;
      const target = page.locator("#target");
      const box = await target.boundingBox();
      if (!box) throw new Error("target button unavailable");

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { clicks?: number }).clicks ?? 0)).toBe(0);

      await expect(session.click("#target")).resolves.toMatchObject({ ok: true });
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { clicks?: number }).clicks ?? 0)).toBe(1);
      expect(await page.locator("#traceforge-control-lock").count()).toBe(1);

      await session.acquireByHuman();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { clicks?: number }).clicks ?? 0)).toBe(2);

      await session.releaseToLlm();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { clicks?: number }).clicks ?? 0)).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("emits one stop event when the Chromium window closes directly", async () => {
    let stopped = 0;
    const { session, events } = makeSession(rules, true, () => { stopped += 1; });
    sessions.push(session);
    await session.start();
    const browser = Reflect.get(session, "browser") as Browser;

    await browser.close();

    expect(stopped).toBe(1);
    expect(events.filter((event) => event.type === "browser_stopped")).toHaveLength(1);
    await session.stop();
    expect(events.filter((event) => event.type === "browser_stopped")).toHaveLength(1);
  });
});
