import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
