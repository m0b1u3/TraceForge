import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";

describe("validation console history with real SQLite", () => {
  it("persists selected validation timeline events in Agent history", async () => {
    const db = createDb(":memory:");
    const app = Fastify();
    const bus = new EventBus();
    registerRoutes(app, db, bus);
    await app.ready();
    const created = await app.inject({ method: "POST", url: "/api/cases", payload: { name: "Console", allowHosts: [] } });
    const caseId = created.json().id as string;
    bus.emit({
      type: "timeline_appended",
      entry: { id: "timeline_1", caseId, runId: "run_1", eventType: "validation_task_claimed", refId: "task_1", detail: "Task=task_1; consensus=insufficient", createdAt: new Date().toISOString() },
    });
    bus.emit({
      type: "timeline_appended",
      entry: { id: "timeline_2", caseId, runId: "run_1", eventType: "validation_feedback_recorded", refId: "task_1", detail: "{}", createdAt: new Date().toISOString() },
    });
    const response = await app.inject({ url: `/api/cases/${caseId}/agent/events` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({ kind: "validation", tool: "validation_task_claimed", text: "Task=task_1; consensus=insufficient" })]);
    await app.close();
  });
});
