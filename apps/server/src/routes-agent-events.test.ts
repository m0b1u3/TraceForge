import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";

let app: FastifyInstance;
let caseId: string;

async function waitForAgentHistory(): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const res = await app.inject({ url: `/api/cases/${caseId}/agent/events` });
    if (res.json().some((e: { kind: string }) => e.kind === "done")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for background agent history");
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  const provider = realLlmProviderForTest();
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

describe("agent events history", () => {
  it("persists agent events during a run and exposes them via the history endpoint", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "用一句中文说明你已收到任务，不要调用工具。" } });
    await waitForAgentHistory();

    const res = await app.inject({ url: `/api/cases/${caseId}/agent/events` });
    expect(res.statusCode).toBe(200);
    const events = res.json();
    const kinds = events.map((e: { kind: string }) => e.kind);
    expect(kinds[0]).toBe("user"); // 先存用户这句目标
    expect(events[0].text).toBe("用一句中文说明你已收到任务，不要调用工具。");
    expect(kinds[1]).toBe("started");
    expect(kinds).toContain("done");
  });

  it("isolates agent events by case", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "用一句中文说明你已收到任务，不要调用工具。" } });
    await waitForAgentHistory();
    const other = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "o", allowHosts: ["t.com"] } })).json().id;
    const res = await app.inject({ url: `/api/cases/${other}/agent/events` });
    expect(res.json()).toHaveLength(0);
  });
});
