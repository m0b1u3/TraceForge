import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@traceforge/shared";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { TrafficStore } from "./stores/traffic-store.js";

describe("traffic persistence routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("deletes persisted traffic through a real HTTP server and broadcasts the cleared case", async () => {
    const app = Fastify();
    const db = createDb(":memory:");
    const bus = new EventBus();
    const events: RuntimeEvent[] = [];
    bus.subscribe((event) => events.push(event));
    registerRoutes(app, db, bus);
    apps.push(app);

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await fetch(`${address}/api/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Traffic persistence", allowHosts: ["127.0.0.1"] }),
    });
    expect(created.status).toBe(200);
    const caseId = String((await created.json() as { id: string }).id);
    const traffic = new TrafficStore(db);
    traffic.add({
      id: "traffic_real_http",
      caseId,
      url: "http://127.0.0.1/health",
      method: "GET",
      requestHeaders: {},
      requestBody: null,
      responseStatus: 200,
      responseBody: "ok",
      createdAt: new Date().toISOString(),
    });

    const before = await fetch(`${address}/api/cases/${caseId}/traffic`);
    expect(await before.json()).toHaveLength(1);

    const cleared = await fetch(`${address}/api/cases/${caseId}/traffic`, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true, deleted: 1 });

    const after = await fetch(`${address}/api/cases/${caseId}/traffic`);
    expect(await after.json()).toEqual([]);
    expect(events.some((event) => event.type === "traffic_cleared" && event.caseId === caseId)).toBe(true);
  });
});
