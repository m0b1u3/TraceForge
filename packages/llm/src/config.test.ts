import { describe, it, expect } from "vitest";
import { LlmConfigSchema, loadLlmConfig } from "./config.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("LlmConfigSchema", () => {
  it("accepts an anthropic config", () => {
    const c = LlmConfigSchema.parse({ provider: "anthropic", model: "some-model", apiKey: "sk-x" });
    expect(c.provider).toBe("anthropic");
    expect(c.baseUrl).toBeUndefined();
  });

  it("accepts an openai-compatible config with baseUrl", () => {
    const c = LlmConfigSchema.parse({
      provider: "openai", model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com", apiKey: "sk-x",
    });
    expect(c.baseUrl).toBe("https://api.deepseek.com");
  });

  it("accepts JSON object mode for OpenAI-compatible providers", () => {
    const c = LlmConfigSchema.parse({
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-x",
      jsonMode: "json_object",
    });
    expect(c.jsonMode).toBe("json_object");
  });

  it("accepts context window and output token limits", () => {
    const c = LlmConfigSchema.parse({
      provider: "openai",
      model: "deepseek-chat",
      apiKey: "sk-x",
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    });
    expect(c.contextWindowTokens).toBe(128000);
    expect(c.maxOutputTokens).toBe(8192);
  });

  it("accepts complete usage pricing and rejects partial pricing", () => {
    const c = LlmConfigSchema.parse({
      provider: "openai",
      model: "priced-model",
      currency: "USD",
      inputPricePerMillion: 2.5,
      outputPricePerMillion: 10,
    });
    expect(c.inputPricePerMillion).toBe(2.5);
    expect(() => LlmConfigSchema.parse({
      provider: "openai",
      model: "partially-priced-model",
      currency: "USD",
    })).toThrow(/both per-million token prices/);
  });

  it("rejects an unknown provider", () => {
    expect(() => LlmConfigSchema.parse({ provider: "grok", model: "m", apiKey: "sk-x" })).toThrow();
  });

  it("validates role routes and model runtime policies", () => {
    const config = LlmConfigSchema.parse({
      provider: "openai",
      model: "primary-model",
      apiKey: "primary-key",
      alternativeRoutes: [{ id: "backup", provider: "anthropic", model: "backup-model", apiKey: "backup-key" }],
      rolePolicies: {
        planner: { routeIds: ["primary", "backup"], timeoutMs: 30_000, maximumRunTokens: 100_000 },
      },
    });
    expect(config.rolePolicies?.planner?.routeIds).toEqual(["primary", "backup"]);
    expect(() => LlmConfigSchema.parse({
      provider: "openai",
      model: "primary-model",
      rolePolicies: { worker: { routeIds: ["missing"] } },
    })).toThrow(/unknown model routes/);
  });

  it("validates model admission and backpressure policy", () => {
    const config = LlmConfigSchema.parse({
      provider: "openai",
      model: "primary-model",
      resourcePolicy: {
        maximumConcurrentCalls: 4,
        maximumConcurrentCallsPerRun: 1,
        maximumQueueDepth: 32,
        roleConcurrency: { planner: 1, observer: 1, worker: 3 },
        rolePriorities: { planner: 80, observer: 100, worker: 60 },
      },
    });
    expect(config.resourcePolicy?.maximumConcurrentCalls).toBe(4);
    expect(() => LlmConfigSchema.parse({
      provider: "openai", model: "primary-model", resourcePolicy: { maximumQueueDepth: 0 },
    })).toThrow();
  });
});

describe("loadLlmConfig", () => {
  it("returns null when the file does not exist", () => {
    expect(loadLlmConfig(join(tmpdir(), "no-such-llm-config.json"))).toBeNull();
  });

  it("loads a valid config file", () => {
    const p = join(tmpdir(), `llm-${Date.now()}.json`);
    writeFileSync(p, JSON.stringify({ provider: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", apiKey: "sk-x" }));
    const c = loadLlmConfig(p);
    expect(c?.model).toBe("deepseek-chat");
    rmSync(p);
  });

  it("loads JSON object mode from config file", () => {
    const p = join(tmpdir(), `llm-json-mode-${Date.now()}.json`);
    writeFileSync(p, JSON.stringify({
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-x",
      jsonMode: "json_object",
    }));
    const c = loadLlmConfig(p);
    expect(c?.jsonMode).toBe("json_object");
    rmSync(p);
  });

  it("finds a relative config path in parent directories", () => {
    const root = join(tmpdir(), `llm-parent-${Date.now()}`);
    const nested = join(root, "apps", "server");
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "config", "llm.json"), JSON.stringify({
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-x",
      jsonMode: "json_object",
    }));
    const c = loadLlmConfig("config/llm.json", nested);
    expect(c?.model).toBe("deepseek-chat");
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null on malformed json", () => {
    const p = join(tmpdir(), `llm-bad-${Date.now()}.json`);
    writeFileSync(p, "{ not json");
    expect(loadLlmConfig(p)).toBeNull();
    rmSync(p);
  });
});
