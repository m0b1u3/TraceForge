import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { LlmConfigService } from "./llm-config-service.js";
import type { LlmProvider } from "@traceforge/llm";
import { mkdtempSync, writeFileSync } from "node:fs";

const mockProvider: LlmProvider = {
  extractJson: async () => ({}),
  runTools: async () => ({ text: "", toolCalls: [], done: true }),
};
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: FastifyInstance;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "rtcfg-"));
  writeFileSync(join(tmp, "llm.json"), JSON.stringify({ provider: "openai", model: "m", apiKey: "sk-old" }));
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  const svc = new LlmConfigService(join(tmp, "llm.json"));
  registerRoutes(app, db, bus, mockProvider, undefined, svc);
  await app.ready();
});

describe("config routes", () => {
  it("GET /api/config/llm returns masked config", async () => {
    const res = await app.inject({ url: "/api/config/llm" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("openai");
    expect(body.apiKeyMasked).toContain("•");
  });

  it("POST /api/config/llm updates config and env", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/llm",
      payload: { provider: "anthropic", model: "claude", apiKey: "sk-new" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("anthropic");
  });

  it("POST /api/config/llm returns 400 when model is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/llm",
      payload: { provider: "openai" },
    });
    expect(res.statusCode).toBe(400);
  });
});
