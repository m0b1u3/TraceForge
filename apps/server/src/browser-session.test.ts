import http from "node:http";
import { afterEach, describe, it, expect } from "vitest";
import { BrowserSession } from "./browser-session.js";
import { EventBus } from "./event-bus.js";
import { createDb } from "./db/client.js";
import { TrafficStore } from "./stores/traffic-store.js";
import type { Browser, Page } from "playwright";
import type { ScopeRule, RuntimeEvent } from "@traceforge/shared";

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for real browser response capture");
}

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
      const navigation = await session.navigate(`http://${allowedHost}/login`);

      const captured = await waitFor(() => {
        const entry = traffic.listByCase("c").find((candidate) => candidate.url === `http://${allowedHost}/login`);
        return entry?.responseBody === "ok" ? entry : undefined;
      });
      const entries = traffic.listByCase("c");
      expect(entries.filter((entry) => entry.url === `http://${allowedHost}/login`)).toHaveLength(1);
      expect(captured).toMatchObject({ responseStatus: 200, contentType: "text/plain; charset=utf-8", responseSize: 2, responseBody: "ok" });
      expect(captured.responseHeaders?.["content-type"]).toBe("text/plain; charset=utf-8");
      expect(events.some((event) => event.type === "response_captured" && event.entry.responseBody === "ok")).toBe(true);
      const trace = (navigation as typeof navigation & { meta: { browserAction: { kind: string; beforeUrl: string; afterUrl: string; trafficIds: string[] } } }).meta.browserAction;
      expect(trace).toMatchObject({ kind: "navigate", beforeUrl: "about:blank", afterUrl: `http://${allowedHost}/login` });
      expect(trace.trafficIds).toContain(captured.id);
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
      await session.acquireByHuman();
      const page = Reflect.get(session, "page") as Page;
      await page.goto(visitedUrl);

      expect(traffic.listByCase("c").some((entry) => entry.url === visitedUrl)).toBe(true);
      await expect(session.navigate(visitedUrl)).resolves.toMatchObject({ ok: false });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("blocks an LLM click that would navigate the main frame outside scope", async () => {
    const outside = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("outside");
    });
    await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve));
    const outsideAddress = outside.address();
    if (!outsideAddress || typeof outsideAddress === "string") throw new Error("outside server unavailable");
    const allowed = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<a id="leave" href="http://127.0.0.1:${outsideAddress.port}/outside">leave</a>`);
    });
    await new Promise<void>((resolve) => allowed.listen(0, "127.0.0.1", resolve));
    try {
      const address = allowed.address();
      if (!address || typeof address === "string") throw new Error("allowed server unavailable");
      const allowedHost = `127.0.0.1:${address.port}`;
      const { session } = makeSession([{ caseId: "c", allowHosts: [allowedHost], denyHosts: [] }], true);
      sessions.push(session);
      await session.start();
      await session.navigate(`http://${allowedHost}/`);

      await expect(session.click("#leave")).resolves.toMatchObject({ ok: false });
      expect(session.currentUrl()).toBe(`http://${allowedHost}/`);
    } finally {
      await new Promise<void>((resolve, reject) => allowed.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => outside.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("observes real interactive elements and acts through stable refs", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<input aria-label="Query"><select aria-label="Mode"><option value="safe">Safe</option><option value="deep">Deep</option></select><p id="status">Ready</p><button onclick="document.body.dataset.result='submitted';document.title='Complete';document.getElementById('status').textContent='Submission accepted'">Submit</button>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server unavailable");
      const allowedHost = `127.0.0.1:${address.port}`;
      const { session } = makeSession([{ caseId: "c", allowHosts: [allowedHost], denyHosts: [] }], true);
      sessions.push(session);
      await session.start();
      await session.navigate(`http://${allowedHost}/`);
      const observation = JSON.parse(await session.observePage()) as { elements: Array<{ ref: string; name: string; tag: string }> };
      const query = observation.elements.find((item) => item.name === "Query");
      const mode = observation.elements.find((item) => item.name === "Mode");
      const submit = observation.elements.find((item) => item.name === "Submit");
      expect(query && mode && submit).toBeTruthy();

      const fillResult = await session.fill(query!.ref, "evidence") as { ok: boolean; content: string; meta: { browserAction: { pageDiff: { changed: boolean; controlChanges: Array<{ after?: { value: string } }> } } } };
      expect(fillResult.ok).toBe(true);
      expect(fillResult.meta.browserAction.pageDiff.changed).toBe(true);
      expect(fillResult.meta.browserAction.pageDiff.controlChanges.some((change) => change.after?.value === "evidence")).toBe(true);
      await expect(session.selectOption(mode!.ref, "deep")).resolves.toMatchObject({ ok: true });
      const clickResult = await session.click(submit!.ref) as { ok: boolean; content: string; meta: { browserAction: { beforeState: { title: string }; afterState: { title: string }; pageDiff: { titleChanged: boolean; addedText: string[]; removedText: string[] } } } };
      expect(clickResult.ok).toBe(true);
      expect(clickResult.meta.browserAction).toMatchObject({ beforeState: { title: "" }, afterState: { title: "Complete" }, pageDiff: { titleChanged: true } });
      expect(clickResult.meta.browserAction.pageDiff.addedText).toContain("Submission accepted");
      expect(clickResult.meta.browserAction.pageDiff.removedText).toContain("Ready");
      expect(clickResult.content).toContain("Page state change");
      const page = Reflect.get(session, "page") as Page;
      expect(await page.locator("input").inputValue()).toBe("evidence");
      expect(await page.locator("select").inputValue()).toBe("deep");
      expect(await page.evaluate(() => document.body.dataset.result)).toBe("submitted");
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
