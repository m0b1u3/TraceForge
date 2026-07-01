import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { MockProvider } from "@traceforge/llm";

let app: FastifyInstance;
let caseId: string;

async function waitForWarningCount(count: number) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const res = await app.inject({ url: `/api/cases/${caseId}/warnings` });
    if (res.json().length === count) return res;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Observer warnings");
}

function buildWith(extractResult: unknown) {
  app = Fastify();
  const db = createDb(":memory:");
  const provider = new MockProvider(extractResult, [{ text: "看一下", toolCalls: [], done: true }]);
  registerRoutes(app, db, new EventBus(), provider);
}

beforeEach(async () => {
  buildWith({ warnings: [{ level: "warning", title: "过早结束", description: "还有点没测", suggestedAction: "继续测 X" }] });
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

describe("observer integration", () => {
  it("agent run triggers Observer; GET /warnings returns produced warnings", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测登录" } });
    const res = await waitForWarningCount(1);
    expect(res.statusCode).toBe(200);
    const warnings = res.json();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warning", title: "过早结束", caseId });
  });

  it("GET /warnings is empty before any run", async () => {
    const res = await app.inject({ url: `/api/cases/${caseId}/warnings` });
    expect(res.json()).toEqual([]);
  });
});
