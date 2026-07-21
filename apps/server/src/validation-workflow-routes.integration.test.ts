import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { TaskStore } from "./stores/task-store.js";

describe("validation workflow routes with real SQLite", () => {
  it("exposes the snapshot and blocks generic HTTP status mutation for consensus tasks", async () => {
    const db = createDb(":memory:");
    const app = Fastify();
    registerRoutes(app, db, new EventBus());
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

    const snapshot = await app.inject({ url: `/api/cases/${caseId}/validation/workflow?runId=run_1` });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toEqual(expect.objectContaining({ caseId, runId: "run_1", runningLease: null }));
    await app.close();
  });
});
