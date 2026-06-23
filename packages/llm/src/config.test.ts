import { describe, it, expect } from "vitest";
import { LlmConfigSchema, loadLlmConfig } from "./config.js";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("LlmConfigSchema", () => {
  it("accepts an anthropic config", () => {
    const c = LlmConfigSchema.parse({ provider: "anthropic", model: "some-model", apiKeyEnv: "ANTHROPIC_API_KEY" });
    expect(c.provider).toBe("anthropic");
    expect(c.baseUrl).toBeUndefined();
  });

  it("accepts an openai-compatible config with baseUrl", () => {
    const c = LlmConfigSchema.parse({
      provider: "openai", model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY",
    });
    expect(c.baseUrl).toBe("https://api.deepseek.com");
  });

  it("rejects an unknown provider", () => {
    expect(() => LlmConfigSchema.parse({ provider: "grok", model: "m", apiKeyEnv: "K" })).toThrow();
  });
});

describe("loadLlmConfig", () => {
  it("returns null when the file does not exist", () => {
    expect(loadLlmConfig(join(tmpdir(), "no-such-llm-config.json"))).toBeNull();
  });

  it("loads a valid config file", () => {
    const p = join(tmpdir(), `llm-${Date.now()}.json`);
    writeFileSync(p, JSON.stringify({ provider: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" }));
    const c = loadLlmConfig(p);
    expect(c?.model).toBe("deepseek-chat");
    rmSync(p);
  });

  it("returns null on malformed json", () => {
    const p = join(tmpdir(), `llm-bad-${Date.now()}.json`);
    writeFileSync(p, "{ not json");
    expect(loadLlmConfig(p)).toBeNull();
    rmSync(p);
  });
});
