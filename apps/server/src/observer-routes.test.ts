import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { MockProvider } from "@traceforge/llm";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let caseId: string;
let events: RuntimeEvent[];

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
  events = [];
  const db = createDb(":memory:");
  const provider = new MockProvider(extractResult, [{ text: "看一下", toolCalls: [], done: true }]);
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  registerRoutes(app, db, bus, provider);
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
    expect(warnings[0]).toMatchObject({
      level: "warning",
      title: "过早结束",
      caseId,
      status: "open",
      suggestedGoal: "[Observer correction]\n继续测 X",
      resolvedAt: null,
    });
    expect(warnings[0].relatedRunId).toMatch(/^run_/);
  });

  it("GET /warnings is empty before any run", async () => {
    const res = await app.inject({ url: `/api/cases/${caseId}/warnings` });
    expect(res.json()).toEqual([]);
  });

  it("accepts an open warning and emits an update event", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测登录" } });
    const warning = (await waitForWarningCount(1)).json()[0];

    const res = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/accept` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: warning.id, status: "accepted" });
    expect(res.json().resolvedAt).toEqual(expect.any(String));
    expect(events).toContainEqual({ type: "observer_warning_updated", warning: res.json() });
  });

  it("dismisses an open warning and emits an update event", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测登录" } });
    const warning = (await waitForWarningCount(1)).json()[0];

    const res = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/dismiss` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: warning.id, status: "dismissed" });
    expect(events).toContainEqual({ type: "observer_warning_updated", warning: res.json() });
  });

  it("converts an open warning into a task and emits task/timeline/update events", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测登录" } });
    const warning = (await waitForWarningCount(1)).json()[0];

    const res = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/convert-task` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.warning).toMatchObject({ id: warning.id, status: "converted_to_task" });
    expect(body.task).toMatchObject({
      caseId,
      title: "过早结束",
      status: "open",
      relatedFacts: [],
      priority: "medium",
    });
    expect(body.task.reason).toContain("还有点没测");
    expect(body.task.reason).toContain("Observer 建议：继续测 X");
    expect(events).toContainEqual({ type: "task_created", task: body.task });
    expect(events).toContainEqual({ type: "observer_warning_updated", warning: body.warning });
    expect(events.some((event) => event.type === "timeline_appended" && event.entry.refId === body.task.id)).toBe(true);
  });
});
