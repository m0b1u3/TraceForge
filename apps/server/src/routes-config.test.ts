import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { LlmConfigService } from "./llm-config-service.js";
import type { LlmSecretBundle } from "./llm-config-service.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: FastifyInstance;
let tmp: string;
let llmService: LlmConfigService;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "rtcfg-"));
  writeFileSync(join(tmp, "llm.json"), JSON.stringify({ provider: "openai", model: "m", apiKey: "sk-old" }));
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  let secrets: LlmSecretBundle = { alternativeRoutes: {} };
  llmService = new LlmConfigService(join(tmp, "llm.json"), { secretStore: {
    load: () => structuredClone(secrets),
    save: (value) => { secrets = structuredClone(value); },
  } });
  llmService.initializeFromConfig();
  registerRoutes(app, db, bus, llmService.getProvider(), llmService);
  await app.ready();
});

describe("config routes", () => {
  it("GET /api/config/llm returns masked config", async () => {
    const res = await app.inject({ url: "/api/config/llm" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("openai");
    expect(body).not.toHaveProperty("apiKey");
    expect(body.apiKeyMasked).toContain("•");
  });

  it("does not expose a route that reveals the stored key", async () => {
    const res = await app.inject({ method: "POST", url: "/api/config/llm/reveal-key" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("sk-old");
  });

  it("POST /api/config/llm updates config and env", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/llm",
      payload: { provider: "anthropic", model: "claude", apiKey: "sk-new" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("anthropic");
    expect(res.json()).not.toHaveProperty("apiKey");
    expect(readFileSync(join(tmp, "llm.json"), "utf8")).not.toContain("sk-new");
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
