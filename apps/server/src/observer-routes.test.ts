import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import type { Db } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import type { RuntimeEvent } from "@traceforge/shared";
import { ObserverWarningStore } from "./stores/observer-store.js";

let app: FastifyInstance;
let caseId: string;
let events: RuntimeEvent[];
let db: Db;

function buildApp() {
  app = Fastify();
  events = [];
  db = createDb(":memory:");
  const provider = realLlmProviderForTest();
  const bus = new EventBus();
  bus.subscribe((event) => events.push(event));
  registerRoutes(app, db, bus, provider);
}

beforeEach(async () => {
  buildApp();
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

function createOpenWarning() {
  return new ObserverWarningStore(db).create({
    id: "warn_test",
    caseId,
    level: "warning",
    title: "过早结束",
    description: "还有点没测",
    relatedFacts: [],
    relatedTasks: [],
    suggestedAction: "继续测 X",
    status: "open",
    relatedRunId: "run_test",
    suggestedGoal: "[Observer correction]\n继续测 X",
    resolvedAt: null,
    createdAt: new Date().toISOString(),
  });
}

describe("observer integration", () => {
  it("GET /warnings returns stored warnings", async () => {
    createOpenWarning();
    const res = await app.inject({ url: `/api/cases/${caseId}/warnings` });
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
    expect(warnings[0].relatedRunId).toBe("run_test");
  });

  it("GET /warnings is empty before any run", async () => {
    const res = await app.inject({ url: `/api/cases/${caseId}/warnings` });
    expect(res.json()).toEqual([]);
  });

  it("accepts an open warning and emits an update event", async () => {
    const warning = createOpenWarning();

    const res = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/accept` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: warning.id, status: "accepted" });
    expect(res.json().resolvedAt).toEqual(expect.any(String));
    expect(events).toContainEqual({ type: "observer_warning_updated", warning: res.json() });
  });

  it("dismisses an open warning and emits an update event", async () => {
    const warning = createOpenWarning();

    const res = await app.inject({ method: "POST", url: `/api/observer/warnings/${warning.id}/dismiss` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: warning.id, status: "dismissed" });
    expect(events).toContainEqual({ type: "observer_warning_updated", warning: res.json() });
  });

  it("converts an open warning into a task and emits task/timeline/update events", async () => {
    const warning = createOpenWarning();

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
