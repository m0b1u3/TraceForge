import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";

let app: FastifyInstance;
let caseId: string;

async function waitFor(assertion: () => Promise<boolean> | boolean, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
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
  }, 60000);
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  const provider = realLlmProviderForTest();
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: [] } })).json().id;
});

describe("cognitive context across runs", () => {
  it("second run sees first run conversation in history", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "用一句中文说明你已收到第一轮任务，不要调用工具。" } });
    await waitForDoneEvents(app, caseId, 1);
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "同意，继续用一句中文确认，不要调用工具。" } });
    await waitForDoneEvents(app, caseId, 2);
    const events = (await app.inject({ url: `/api/cases/${caseId}/agent/events` })).json();
    const userTexts = events.filter((e: { kind: string }) => e.kind === "user").map((e: { text: string }) => e.text);
    expect(userTexts).toContain("用一句中文说明你已收到第一轮任务，不要调用工具。");
    expect(userTexts).toContain("同意，继续用一句中文确认，不要调用工具。");
    const doneTexts = events.filter((e: { kind: string }) => e.kind === "done").map((e: { text: string }) => e.text);
    expect(doneTexts.length).toBeGreaterThanOrEqual(2);
  }, 60000);

  it("text events from agent turns are persisted (Fix 2: recentConvo includes text kind)", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "第一轮：用一句中文确认收到，不要调用工具。" } });
    await waitForDoneEvents(app, caseId, 1);
    const events = (await app.inject({ url: `/api/cases/${caseId}/agent/events` })).json();
    const allKinds = events.map((e: { kind: string }) => e.kind) as string[];
    expect(allKinds).toContain("user");
    expect(allKinds).toContain("done");
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "第二轮：用一句中文确认收到，不要调用工具。" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.id).toEqual(expect.any(String));
    await waitForDoneEvents(app, caseId, 2);
  }, 60000);
});
