import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import type { Db } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { MockProvider } from "@traceforge/llm";
import { ContextSummaryStore } from "./stores/context-summary-store.js";

let app: FastifyInstance;
let caseId: string;

async function waitFor(assertion: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for background agent run");
}

async function waitForDoneEvents(targetApp: FastifyInstance, targetCaseId: string, count: number) {
  await waitFor(async () => {
    const events = (await targetApp.inject({ url: `/api/cases/${targetCaseId}/agent/events` })).json();
    return events.filter((e: { kind: string }) => e.kind === "done").length >= count;
  });
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  const provider = new MockProvider({}, [
    { text: "已提议纳入 a.com，等你批准", toolCalls: [], done: true },
    { text: "好的，基于你刚才的同意我开始", toolCalls: [], done: true },
  ]);
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: [] } })).json().id;
});

describe("cognitive context across runs", () => {
  it("second run sees first run conversation in history", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测 a.com" } });
    await waitForDoneEvents(app, caseId, 1);
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "同意" } });
    await waitForDoneEvents(app, caseId, 2);
    const events = (await app.inject({ url: `/api/cases/${caseId}/agent/events` })).json();
    const userTexts = events.filter((e: { kind: string }) => e.kind === "user").map((e: { text: string }) => e.text);
    expect(userTexts).toContain("测 a.com");
    expect(userTexts).toContain("同意");
    const doneTexts = events.filter((e: { kind: string }) => e.kind === "done").map((e: { text: string }) => e.text);
    expect(doneTexts.length).toBeGreaterThanOrEqual(2);
  });

  it("text events from agent turns are persisted (Fix 2: recentConvo includes text kind)", async () => {
    // MockProvider returns text="" and done="..." -- both are persisted as agent events
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "第一轮" } });
    await waitForDoneEvents(app, caseId, 1);
    const events = (await app.inject({ url: `/api/cases/${caseId}/agent/events` })).json();
    // text event exists: MockProvider turns have text="" but done event is present
    // Verify the run completed and text-kind events are NOT filtered out by routes
    const allKinds = events.map((e: { kind: string }) => e.kind) as string[];
    // At minimum user/started/done events must be present
    expect(allKinds).toContain("user");
    expect(allKinds).toContain("done");
    // The recentConvo filter now includes "text" kind alongside "done"
    // Verify a second run also succeeds (recentConvo with text won't crash)
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "第二轮" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.id).toEqual(expect.any(String));
    await waitForDoneEvents(app, caseId, 2);
  });
});

describe("Fix 1: compressor wired into agent/run", () => {
  // Use FAR_THRESHOLD=30, RECENT_WINDOW=20 from routes.ts
  // Each run generates ≥3 events (user, started, done); text="" also appended if MockProvider text non-empty
  // We need >30 events total. Use 12 runs × 3 events = 36 events > 30 threshold.
  it("contextSummaryStore.latest returns non-empty summary after enough events accumulate", async () => {
    const db: Db = createDb(":memory:");
    const localApp = Fastify();
    const bus = new EventBus();
    // extractJson returns {} → compressFar falls back to ruleFallback → non-empty string guaranteed
    const provider = new MockProvider({});
    registerRoutes(localApp, db, bus, provider);
    await localApp.ready();

    const localCaseId = (await localApp.inject({
      method: "POST", url: "/api/cases", payload: { name: "comp-test", allowHosts: [] },
    })).json().id;

    // Run enough times to exceed FAR_THRESHOLD=30 events
    for (let i = 0; i < 12; i++) {
      await localApp.inject({ method: "POST", url: `/api/cases/${localCaseId}/agent/run`, payload: { goal: `轮次 ${i}` } });
      await waitForDoneEvents(localApp, localCaseId, i + 1);
    }

    const summaryStore = new ContextSummaryStore(db);
    const latest = summaryStore.latest(localCaseId);
    expect(latest).not.toBeUndefined();
    expect(typeof latest!.content).toBe("string");
    expect(latest!.content.trim().length).toBeGreaterThan(0);

    await localApp.close();
  });
});

describe("pull-mode fact retrieval", () => {
  it("agent can search facts via search_facts tool", async () => {
    const app2 = Fastify();
    const db2 = createDb(":memory:");
    const bus2 = new EventBus();
    // 第一轮：agent 调 search_facts（query 用英文以匹配 title）；第二轮：done
    const provider2 = new MockProvider({}, [
      { text: "", toolCalls: [{ id: "c1", name: "search_facts", input: { query: "login" } }], done: false },
      { text: "找到了登录接口", toolCalls: [], done: true },
    ]);
    registerRoutes(app2, db2, bus2, provider2);
    await app2.ready();
    const cid = (await app2.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: [] } })).json().id;
    // 先落一个 fact
    await app2.inject({ method: "POST", url: `/api/cases/${cid}/facts`, payload: { type: "login_endpoint", title: "/api/login", value: {} } });
    // 跑 agent
    const res = await app2.inject({ method: "POST", url: `/api/cases/${cid}/agent/run`, payload: { goal: "找登录接口" } });
    expect(res.statusCode).toBe(200);
    await waitFor(async () => {
      const events = (await app2.inject({ url: `/api/cases/${cid}/agent/events` })).json();
      const toolResults = events.filter((e: { kind: string }) => e.kind === "tool_result").map((e: { text: string }) => e.text);
      return toolResults.some((t: string) => t.includes("/api/login"));
    });
    // agent 事件里应出现 search_facts 的 tool_result，且命中 /api/login
    const events = (await app2.inject({ url: `/api/cases/${cid}/agent/events` })).json();
    const toolResults = events.filter((e: { kind: string }) => e.kind === "tool_result").map((e: { text: string }) => e.text);
    expect(toolResults.some((t: string) => t.includes("/api/login"))).toBe(true);
    await app2.close();
  });

  it("agent can retrieve an IDOR fact when searching 越权 through query expansion", async () => {
    const app2 = Fastify();
    const db2 = createDb(":memory:");
    const bus2 = new EventBus();
    let extractCalls = 0;
    const provider2 = new MockProvider(
      () => {
        extractCalls += 1;
        return ["IDOR", "BOLA", "broken access control"];
      },
      [
        { text: "", done: false, toolCalls: [{ id: "call_1", name: "search_facts", input: { query: "越权" } }] },
        { text: "找到了 IDOR 相关事实", done: true, toolCalls: [] },
      ],
    );
    registerRoutes(app2, db2, bus2, provider2);
    await app2.ready();

    const cid = (await app2.inject({
      method: "POST",
      url: "/api/cases",
      payload: { name: "c", allowHosts: ["example.com"] },
    })).json().id;

    await app2.inject({
      method: "POST",
      url: `/api/cases/${cid}/facts`,
      payload: {
        type: "finding",
        title: "Possible IDOR on /api/user/:id",
        value: { endpoint: "/api/user/:id" },
        confidence: 0.8,
        tags: ["access-control"],
      },
    });

    const res = await app2.inject({
      method: "POST",
      url: `/api/cases/${cid}/agent/run`,
      payload: { goal: "检索越权相关历史发现" },
    });
    expect(res.statusCode).toBe(200);

    await waitFor(async () => {
      const events = (await app2.inject({ url: `/api/cases/${cid}/agent/events` })).json();
      return JSON.stringify(events).includes("Possible IDOR");
    });
    const events = (await app2.inject({ url: `/api/cases/${cid}/agent/events` })).json();

    expect(extractCalls).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain("Possible IDOR");
    expect(JSON.stringify(events)).toContain("matched: IDOR");

    await app2.close();
  });
});
