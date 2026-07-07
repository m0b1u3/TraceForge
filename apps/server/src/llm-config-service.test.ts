import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmConfigService } from "./llm-config-service.js";

function makeEnv(tmp: string, key: string, value: string) {
  writeFileSync(join(tmp, ".env"), `${key}=${value}\n`);
}

function makeConfig(tmp: string, cfg: object) {
  writeFileSync(join(tmp, "llm.json"), JSON.stringify(cfg));
}

describe("LlmConfigService", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "llmcfg-")); });

  it("loads config and masks the key", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKeyEnv: "K", jsonMode: "json_object" });
    makeEnv(tmp, "K", "sk-abcdef123456");
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    const cfg = svc.load();
    expect(cfg.provider).toBe("openai");
    expect(cfg.apiKeyMasked).toBe("••••••••");
  });

  it("throws on malformed JSON in config file", () => {
    writeFileSync(join(tmp, "llm.json"), "not json");
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    expect(() => svc.load()).toThrow();
  });

  it("throws on missing config file", () => {
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    expect(() => svc.load()).toThrow();
  });

  it("throws on invalid config schema", () => {
    makeConfig(tmp, { provider: "invalid", model: "m" });
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    expect(() => svc.load()).toThrow(/invalid LLM config/);
  });

  it("reloads with a new api key and updates files", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKeyEnv: "K" });
    makeEnv(tmp, "K", "old");
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    svc.reload({ provider: "anthropic", model: "claude", apiKey: "sk-new", apiKeyEnv: "K" });
    const json = JSON.parse(readFileSync(join(tmp, "llm.json"), "utf8"));
    expect(json.provider).toBe("anthropic");
    expect(json.model).toBe("claude");
    expect(readFileSync(join(tmp, ".env"), "utf8")).toContain("K=sk-new");
  });

  it("keeps other env vars when updating key", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKeyEnv: "K" });
    makeEnv(tmp, "K", "old");
    writeFileSync(join(tmp, ".env"), "OTHER=x\nK=old\n");
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    svc.reload({ provider: "openai", model: "m", apiKey: "sk-new" });
    const env = readFileSync(join(tmp, ".env"), "utf8");
    expect(env).toContain("OTHER=x");
    expect(env).toContain("K=sk-new");
  });

  it("generates default apiKeyEnv when missing", () => {
    makeConfig(tmp, { provider: "anthropic", model: "m" });
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    svc.reload({ provider: "anthropic", model: "m", apiKey: "sk-x" });
    const json = JSON.parse(readFileSync(join(tmp, "llm.json"), "utf8"));
    expect(json.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
  });

  it("sets process.env during reload when apiKey is provided", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKeyEnv: "TEST_KEY" });
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    svc.reload({ provider: "openai", model: "m", apiKey: "sk-test", apiKeyEnv: "TEST_KEY" });
    expect(process.env.TEST_KEY).toBe("sk-test");
    delete process.env.TEST_KEY;
  });

  it("returns a provider holder from getProvider()", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKeyEnv: "K" });
    makeEnv(tmp, "K", "old");
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    const provider = svc.getProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.extractJson).toBe("function");
    expect(typeof provider.runTools).toBe("function");
  });

  it("handles missing env file gracefully in load", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKeyEnv: "K" });
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    const cfg = svc.load();
    expect(cfg.apiKeyMasked).toBe("");
  });

  it("handles missing apiKeyEnv in env file", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKeyEnv: "MISSING_KEY" });
    makeEnv(tmp, "OTHER_KEY", "value");
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    const cfg = svc.load();
    expect(cfg.apiKeyMasked).toBe("");
  });

  it("propagates provider creation errors during reload", () => {
    const uniqueEnv = "UNSET_KEY_" + Date.now();
    makeConfig(tmp, { provider: "openai", model: "m", apiKeyEnv: uniqueEnv });
    const svc = new LlmConfigService(join(tmp, "llm.json"), join(tmp, ".env"));
    expect(() => svc.reload({ provider: "openai", model: "m" })).toThrow(/env var/);
  });
});
