import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import type { LlmProvider, RunToolsArgs, RunTurn, ExtractJsonArgs } from "@traceforge/extension";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let caseId: string;
let events: RuntimeEvent[];
let capturedSystems: string[];

function capturingProvider(): LlmProvider {
  return {
    extractJson: async (_args: ExtractJsonArgs) => ({ warnings: [] }),
    runTools: async (args: RunToolsArgs): Promise<RunTurn> => {
      capturedSystems.push(args.system);
      return { text: "done", toolCalls: [], done: true };
    },
  };
}

beforeEach(async () => {
  app = Fastify();
  events = [];
  capturedSystems = [];
  const db = createDb(":memory:");
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  registerRoutes(app, db, bus, capturingProvider());
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "m", allowHosts: ["t.com"] } })).json().id;
});

describe("agent methodology prompt", () => {
  it("includes auth testing order and evidence-driven instructions", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "test login" } });
    await new Promise((r) => setTimeout(r, 100));
    const system = capturedSystems[0];
    expect(system).toContain("常见/弱口令凭据");
    expect(system).toContain("记录为 Fact");
    expect(system).toContain("search_facts");
    expect(system).toContain("不要无差别爆破");
  });

  it("includes failure-memory and download_tool instructions", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "test fallback" } });
    await new Promise((r) => setTimeout(r, 100));
    const system = capturedSystems[0];
    expect(system).toContain("已经执行失败");
    expect(system).toContain("download_tool");
    expect(system).toContain("failed_attempt");
    expect(system).toContain("不要一直重复尝试");
  });
});
