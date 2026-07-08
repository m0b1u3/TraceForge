import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import type { Db } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import type { RuntimeEvent } from "@traceforge/shared";
import type { LlmProvider, RunToolsArgs, RunTurn, ExtractJsonArgs } from "@traceforge/extension";

let app: FastifyInstance;
let caseId: string;
let events: RuntimeEvent[];
let db: Db;

function criticalWarningProvider(): LlmProvider {
  return {
    extractJson: async (_args: ExtractJsonArgs) => ({
      warnings: [
        {
          level: "critical",
          title: "偏离目标",
          description: "agent 一直在测试无关接口",
          relatedFacts: [],
          relatedTasks: [],
          suggestedAction: "回到登录流程",
          suggestedGoal: "",
        },
      ],
    }),
    runTools: async (_args: RunToolsArgs): Promise<RunTurn> => ({
      text: "call tool",
      toolCalls: [{ id: "tc_1", name: "noop", input: {} }],
      done: false,
    }),
  };
}

function buildApp() {
  app = Fastify();
  events = [];
  db = createDb(":memory:");
  const provider = criticalWarningProvider();
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  registerRoutes(app, db, bus, provider);
}

beforeEach(async () => {
  buildApp();
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

function waitForEvent(type: RuntimeEvent["type"], timeoutMs = 2000): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const existing = events.find((e) => e.type === type);
    if (existing) return resolve(existing);
    const start = Date.now();
    const iv = setInterval(() => {
      const found = events.find((e) => e.type === type);
      if (found) {
        clearInterval(iv);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timed out waiting for event ${type}`));
      }
    }, 50);
  });
}

describe("observer intervention", () => {
  it("pauses the run and emits needs_confirmation when a critical warning is raised", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "test login" } });
    expect(res.statusCode).toBe(200);

    const needsConfirmation = await waitForEvent("agent_run_needs_confirmation");
    expect(needsConfirmation).toMatchObject({ caseId, runId: expect.any(String) });
    expect(needsConfirmation).toHaveProperty("warning");

    const interrupted = await waitForEvent("agent_run_interrupted");
    expect(interrupted).toHaveProperty("run");
    expect((interrupted as { run: { status: string } }).run.status).toBe("interrupted");

    expect(events.some((e) => e.type === "agent_run_completed")).toBe(false);
  });
});
