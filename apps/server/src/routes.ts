import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { chromium } from "playwright";
import { checkScope } from "@traceforge/tool-resolver";
import type { Db } from "./db/client.js";
import { CaseStore } from "./stores/case-store.js";
import { TrafficStore } from "./stores/traffic-store.js";
import { FactStore } from "./stores/fact-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { EventBus } from "./event-bus.js";
import type { Task } from "@traceforge/shared";

export function registerRoutes(app: FastifyInstance, db: Db, bus: EventBus): void {
  const cases = new CaseStore(db);
  const traffic = new TrafficStore(db);
  const factStore = new FactStore(db);
  const taskStore = new TaskStore(db);
  const timelineStore = new TimelineStore(db);

  app.post("/api/cases", async (req) => {
    const body = req.body as { name: string; allowHosts: string[]; denyHosts?: string[] };
    const c = cases.create(body.name, [
      { caseId: "pending", allowHosts: body.allowHosts, denyHosts: body.denyHosts ?? [] },
    ]);
    bus.emit({ type: "case_created", case: c });
    return c;
  });

  app.get("/api/cases", async () => cases.list());

  app.get("/api/cases/:id/traffic", async (req) => {
    const { id } = req.params as { id: string };
    return traffic.listByCase(id);
  });

  app.post("/api/cases/:id/open", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { url } = req.body as { url: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });

    const verdict = checkScope(url, c.scopeRules);
    if (!verdict.allowed) {
      bus.emit({ type: "scope_violation", caseId: id, url, reason: verdict.reason });
      return reply.code(403).send({ error: "out of scope", reason: verdict.reason });
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("response", (res) => {
      const resVerdict = checkScope(res.url(), c.scopeRules);
      if (!resVerdict.allowed) return; // 不捕获越界资源
      const entry = {
        id: `traf_${randomUUID()}`,
        caseId: id,
        url: res.url(),
        method: res.request().method(),
        requestHeaders: res.request().headers(),
        responseStatus: res.status(),
        responseBody: null as string | null,
        createdAt: new Date().toISOString(),
      };
      traffic.add(entry);
      bus.emit({ type: "response_captured", entry });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await browser.close();
    return { ok: true };
  });

  app.post("/api/cases/:id/facts", async (req) => {
    const { id } = req.params as { id: string };
    const input = req.body as Parameters<FactStore["create"]>[1];
    const fact = factStore.create(id, input);
    const entry = timelineStore.append(id, "fact_created", `Fact: ${fact.title}`, fact.id);
    bus.emit({ type: "fact_created", fact });
    bus.emit({ type: "timeline_appended", entry });
    return fact;
  });

  app.get("/api/cases/:id/facts", async (req) => {
    const { id } = req.params as { id: string };
    return factStore.listByCase(id);
  });

  app.post("/api/cases/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    const input = req.body as Parameters<TaskStore["create"]>[1];
    const task = taskStore.create(id, input);
    const entry = timelineStore.append(id, "task_created", `Task: ${task.title}`, task.id);
    bus.emit({ type: "task_created", task });
    bus.emit({ type: "timeline_appended", entry });
    return task;
  });

  app.get("/api/cases/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return taskStore.listByCase(id);
  });

  app.patch("/api/tasks/:taskId", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const { status, reason } = req.body as { status: Task["status"]; reason?: string };
    const task = taskStore.updateStatus(taskId, status, reason);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const entry = timelineStore.append(task.caseId, "task_updated", `Task ${task.title} → ${status}`, task.id);
    bus.emit({ type: "task_updated", task });
    bus.emit({ type: "timeline_appended", entry });
    return task;
  });

  app.get("/api/cases/:id/timeline", async (req) => {
    const { id } = req.params as { id: string };
    return timelineStore.listByCase(id);
  });
}
