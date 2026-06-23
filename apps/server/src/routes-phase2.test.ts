import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  registerRoutes(app, db, bus);
  await app.ready();
  const res = await app.inject({
    method: "POST", url: "/api/cases",
    payload: { name: "demo", allowHosts: ["t.com"] },
  });
  caseId = res.json().id;
  events.length = 0; // 清掉 case_created
});

describe("facts route", () => {
  it("creates a fact, appends timeline, emits events", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/cases/${caseId}/facts`,
      payload: {
        type: "login_endpoint", title: "admin login",
        value: { url: "https://t.com/admin" }, source: { type: "manual", ref: "page_1" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toMatch(/^fact_/);

    const facts = (await app.inject({ url: `/api/cases/${caseId}/facts` })).json();
    expect(facts).toHaveLength(1);

    const tl = (await app.inject({ url: `/api/cases/${caseId}/timeline` })).json();
    expect(tl.some((e: { eventType: string }) => e.eventType === "fact_created")).toBe(true);

    expect(events.some((e) => e.type === "fact_created")).toBe(true);
    expect(events.some((e) => e.type === "timeline_appended")).toBe(true);
  });
});

describe("tasks route", () => {
  it("creates a blocked task and patches its status", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/cases/${caseId}/tasks`,
      payload: { title: "verify login", status: "blocked", blockedBy: ["credential"], triggerWhen: ["credential_found"] },
    });
    const taskId = created.json().id;
    expect(created.json().status).toBe("blocked");

    const patched = await app.inject({
      method: "PATCH", url: `/api/tasks/${taskId}`,
      payload: { status: "recheck_candidate", reason: "creds found" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe("recheck_candidate");

    expect(events.some((e) => e.type === "task_created")).toBe(true);
    expect(events.some((e) => e.type === "task_updated")).toBe(true);
  });

  it("returns 404 when patching a missing task", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/tasks/nope", payload: { status: "done" } });
    expect(res.statusCode).toBe(404);
  });
});
