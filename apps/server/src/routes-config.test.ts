import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { LlmConfigService } from "./llm-config-service.js";
import type { LlmProvider } from "@traceforge/llm";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: FastifyInstance;
let tmp: string;
let llmService: LlmConfigService;

const mockProvider: LlmProvider = {
  extractJson: async () => ({ ok: true }),
  runTools: async () => ({ text: "", toolCalls: [], done: true }),
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "rtcfg-"));
  writeFileSync(join(tmp, "llm.json"), JSON.stringify({ provider: "openai", model: "m", apiKey: "sk-old" }));
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  llmService = new LlmConfigService(join(tmp, "llm.json"), { createProvider: () => mockProvider });
  registerRoutes(app, db, bus, mockProvider, undefined, llmService);
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

  it("POST /api/config/llm/test returns connection result from provider", async () => {
    mockProvider.extractJson = async () => ({ ok: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/config/llm/test",
      payload: { provider: "openai", model: "m" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("POST /api/config/llm/test returns false when provider does not confirm", async () => {
    mockProvider.extractJson = async () => ({ ok: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/config/llm/test",
      payload: { provider: "openai", model: "m" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });

  it("POST /api/config/llm/test returns 400 when model is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/llm/test",
      payload: { provider: "openai" },
    });
    expect(res.statusCode).toBe(400);
  });
});
