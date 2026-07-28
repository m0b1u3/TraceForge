import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadLlmConfig } from "@traceforge/llm";
import { LlmConfigService } from "./llm-config-service.js";

function makeConfig(tmp: string, cfg: object) {
  writeFileSync(join(tmp, "llm.json"), JSON.stringify(cfg));
}

describe("LlmConfigService", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "llmcfg-")); });

  it("loads config and masks the key", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-abcdef123456", jsonMode: "json_object" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    const cfg = svc.load();
    expect(cfg.provider).toBe("openai");
    expect(cfg.apiKeyMasked).toBe("••••••••");
  });

  it("reveals the persisted key only through the explicit secret method", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-visible-on-demand" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));

    expect(svc.load()).not.toHaveProperty("apiKey");
    expect(svc.revealApiKey()).toBe("sk-visible-on-demand");
  });

  it("throws on malformed JSON in config file", () => {
    writeFileSync(join(tmp, "llm.json"), "not json");
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    expect(() => svc.load()).toThrow();
  });

  it("throws on missing config file", () => {
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    expect(() => svc.load()).toThrow();
  });

  it("throws on invalid config schema", () => {
    makeConfig(tmp, { provider: "invalid", model: "m" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    expect(() => svc.load()).toThrow(/invalid LLM config/);
  });

  it("reloads with a new api key and writes it to config", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "old" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    svc.reload({ provider: "anthropic", model: "claude", apiKey: "sk-new" });
    const json = JSON.parse(readFileSync(join(tmp, "llm.json"), "utf8"));
    expect(json.provider).toBe("anthropic");
    expect(json.model).toBe("claude");
    expect(json.apiKey).toBe("sk-new");
  });

  it("keeps existing api key when not provided during reload", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-existing" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    svc.reload({ provider: "openai", model: "m2" });
    const json = JSON.parse(readFileSync(join(tmp, "llm.json"), "utf8"));
    expect(json.apiKey).toBe("sk-existing");
  });

  it("keeps existing context window settings when they are omitted during reload", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-openai", contextWindowTokens: 128000, maxOutputTokens: 8192 });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    svc.reload({ provider: "openai", model: "m2" });
    const json = JSON.parse(readFileSync(join(tmp, "llm.json"), "utf8"));
    expect(json.contextWindowTokens).toBe(128000);
    expect(json.maxOutputTokens).toBe(8192);
  });

  it("persists, preserves, and explicitly clears complete usage pricing", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-openai" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    svc.reload({
      provider: "openai",
      model: "m",
      currency: "usd",
      inputPricePerMillion: 2.5,
      outputPricePerMillion: 10,
    });
    svc.reload({ provider: "openai", model: "m2" });
    expect(svc.load()).toMatchObject({
      currency: "USD",
      inputPricePerMillion: 2.5,
      outputPricePerMillion: 10,
    });

    svc.reload({
      provider: "openai",
      model: "m2",
      currency: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
    });
    const json = JSON.parse(readFileSync(join(tmp, "llm.json"), "utf8"));
    expect(json.currency).toBeUndefined();
    expect(json.inputPricePerMillion).toBeUndefined();
    expect(json.outputPricePerMillion).toBeUndefined();
  });

  it("initializes the runtime provider from existing config", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-openai" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    const cfg = svc.initializeFromConfig();
    expect(cfg.provider).toBe("openai");
    expect(cfg.apiKeyMasked).toContain("•");
  });

  it("rejects invalid config values before writing files", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-test" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    expect(() => svc.reload({ provider: "invalid" as "openai", model: "m" })).toThrow(/invalid LLM config/);
  });

  it("rejects api keys containing line breaks", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-test" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    expect(() => svc.reload({ provider: "openai", model: "m", apiKey: "sk-test\nEXTRA=x" })).toThrow(/invalid apiKey/);
  });

  it("returns a provider holder from getProvider()", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-old" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    const provider = svc.getProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.extractJson).toBe("function");
    expect(typeof provider.runTools).toBe("function");
  });

  it("handles missing apiKey in config", () => {
    makeConfig(tmp, { provider: "openai", model: "m" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    const cfg = svc.load();
    expect(cfg.apiKeyMasked).toBe("");
  });

  it("propagates provider creation errors during reload when apiKey is missing", () => {
    makeConfig(tmp, { provider: "openai", model: "m" });
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    expect(() => svc.reload({ provider: "openai", model: "m" })).toThrow(/apiKey is missing/);
  });

  it("tests config connectivity when provider confirms", async () => {
    const realConfig = loadLlmConfig(resolve("config/llm.json"));
    if (!realConfig) throw new Error("real LLM config is required for connectivity tests");
    makeConfig(tmp, realConfig);
    const svc = new LlmConfigService(join(tmp, "llm.json"));
    const result = await svc.test({
      provider: realConfig.provider,
      model: realConfig.model,
      baseUrl: realConfig.baseUrl,
      jsonMode: realConfig.jsonMode,
      contextWindowTokens: realConfig.contextWindowTokens,
      maxOutputTokens: realConfig.maxOutputTokens,
    });
    expect(result.ok).toBe(true);
  });
});
