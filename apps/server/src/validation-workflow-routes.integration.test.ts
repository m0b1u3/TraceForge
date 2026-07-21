import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { TaskStore } from "./stores/task-store.js";
import type { RuntimeEvent } from "@traceforge/shared";

describe("validation workflow routes with real SQLite", () => {
  it("exposes the snapshot and blocks generic HTTP status mutation for consensus tasks", async () => {
    const db = createDb(":memory:");
    const app = Fastify();
    const bus = new EventBus();
    const events: RuntimeEvent[] = [];
    bus.subscribe((event) => events.push(event));
    registerRoutes(app, db, bus);
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/api/cases", payload: { name: "API", allowHosts: [] } });
    const caseId = created.json().id as string;
    const tasks = new TaskStore(db);
    const task = tasks.create(caseId, {
      runId: "run_1", title: "[Consensus:fact_1:insufficient] collect", status: "open", reason: "",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: ["hyp_1"], priority: "high",
    });

    const denied = await app.inject({ method: "PATCH", url: `/api/tasks/${task.id}`, payload: { status: "running" } });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toContain("manage_validation_task");
    expect(tasks.getById(task.id)?.status).toBe("open");

    const ordinary = tasks.create(caseId, {
      runId: "run_1", title: "Review endpoint", status: "open", reason: "",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: [], priority: "medium",
    });
    const updated = await app.inject({ method: "PATCH", url: `/api/tasks/${ordinary.id}`, payload: { status: "done" } });
    expect(updated.statusCode).toBe(200);
    expect(events.some((event) => event.type === "validation_workflow_updated" && event.snapshot.caseId === caseId)).toBe(true);

    const snapshot = await app.inject({ url: `/api/cases/${caseId}/validation/workflow?runId=run_1` });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toEqual(expect.objectContaining({ caseId, runId: "run_1", runningLease: null }));
    await app.close();
  });
});
