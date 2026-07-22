import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";

let app: FastifyInstance;
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  registerRoutes(app, db, new EventBus());
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

describe("browser control routes (no real browser)", () => {
  it("reports an inactive browser session for an existing case", async () => {
    const res = await app.inject({ method: "GET", url: `/api/cases/${caseId}/browser` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, controller: null, url: "", identity: null });
  });
  it("takeover returns 404 when no session started", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/browser/takeover` });
    expect(res.statusCode).toBe(404);
  });
  it("release returns 404 when no session started", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/browser/release` });
    expect(res.statusCode).toBe(404);
  });
  it("stop returns 404 when no session started", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/browser/stop` });
    expect(res.statusCode).toBe(404);
  });
  it("the old /open route is removed", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/open`, payload: { url: "https://t.com/" } });
    expect(res.statusCode).toBe(404);
  });
});
