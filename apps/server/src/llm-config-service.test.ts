import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadLlmConfig } from "@traceforge/llm";
import { LlmConfigService, type LlmSecretBundle, type LlmSecretStore } from "./llm-config-service.js";

function makeConfig(tmp: string, cfg: object) {
  writeFileSync(join(tmp, "llm.json"), JSON.stringify(cfg));
}

function memorySecrets(initial: LlmSecretBundle = { alternativeRoutes: {} }): LlmSecretStore & { value: LlmSecretBundle } {
  return {
    value: structuredClone(initial),
    load() { return structuredClone(this.value); },
    save(value) { this.value = structuredClone(value); },
  };
}

function service(tmp: string, options: { secrets?: ReturnType<typeof memorySecrets>; createProvider?: ConstructorParameters<typeof LlmConfigService>[1]["createProvider"] } = {}) {
  return new LlmConfigService(join(tmp, "llm.json"), { secretStore: options.secrets ?? memorySecrets(), createProvider: options.createProvider });
}

describe("LlmConfigService", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "llmcfg-")); });

  it("loads config and masks the key", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-abcdef123456", jsonMode: "json_object" });
    const svc = service(tmp);
    const cfg = svc.load();
    expect(cfg.provider).toBe("openai");
    expect(cfg.apiKeyMasked).toBe("••••••••");
  });

  it("migrates a legacy plaintext key out of metadata without exposing it", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-visible-on-demand" });
    const secrets = memorySecrets();
    const svc = service(tmp, { secrets });

    expect(svc.load()).not.toHaveProperty("apiKey");
    expect(secrets.value.primary).toBe("sk-visible-on-demand");
    expect(readFileSync(join(tmp, "llm.json"), "utf8")).not.toContain("sk-visible-on-demand");
  });

  it("throws on malformed JSON in config file", () => {
    writeFileSync(join(tmp, "llm.json"), "not json");
    const svc = service(tmp);
    expect(() => svc.load()).toThrow();
  });

  it("throws on missing config file", () => {
    const svc = service(tmp);
    expect(() => svc.load()).toThrow();
  });

  it("throws on invalid config schema", () => {
    makeConfig(tmp, { provider: "invalid", model: "m" });
    const svc = service(tmp);
    expect(() => svc.load()).toThrow(/invalid LLM config/);
  });

  it("reloads with a new api key and writes only metadata to config", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "old" });
    const secrets = memorySecrets();
    const svc = service(tmp, { secrets });
    svc.reload({ provider: "anthropic", model: "claude", apiKey: "sk-new" });
    const json = JSON.parse(readFileSync(join(tmp, "llm.json"), "utf8"));
    expect(json.provider).toBe("anthropic");
    expect(json.model).toBe("claude");
    expect(json.apiKey).toBeUndefined();
    expect(secrets.value.primary).toBe("sk-new");
  });

  it("keeps existing api key when not provided during reload", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-existing" });
    const secrets = memorySecrets();
    const svc = service(tmp, { secrets });
    svc.reload({ provider: "openai", model: "m2" });
    const json = JSON.parse(readFileSync(join(tmp, "llm.json"), "utf8"));
    expect(json.apiKey).toBeUndefined();
    expect(secrets.value.primary).toBe("sk-existing");
  });

  it("keeps existing context window settings when they are omitted during reload", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-openai", contextWindowTokens: 128000, maxOutputTokens: 8192 });
    const svc = service(tmp);
    svc.reload({ provider: "openai", model: "m2" });
    const json = JSON.parse(readFileSync(join(tmp, "llm.json"), "utf8"));
    expect(json.contextWindowTokens).toBe(128000);
    expect(json.maxOutputTokens).toBe(8192);
  });

  it("persists, preserves, and explicitly clears complete usage pricing", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-openai" });
    const svc = service(tmp);
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
    const svc = service(tmp);
    const cfg = svc.initializeFromConfig();
    expect(cfg.provider).toBe("openai");
    expect(cfg.apiKeyMasked).toContain("•");
  });

  it("rejects invalid config values before writing files", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-test" });
    const svc = service(tmp);
    expect(() => svc.reload({ provider: "invalid" as "openai", model: "m" })).toThrow(/invalid LLM config/);
  });

  it("rejects api keys containing line breaks", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-test" });
    const svc = service(tmp);
    expect(() => svc.reload({ provider: "openai", model: "m", apiKey: "sk-test\nEXTRA=x" })).toThrow(/invalid apiKey/);
  });

  it("returns a provider holder from getProvider()", () => {
    makeConfig(tmp, { provider: "openai", model: "m", apiKey: "sk-old" });
    const svc = service(tmp);
    const provider = svc.getProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.extractJson).toBe("function");
    expect(typeof provider.runTools).toBe("function");
  });

  it("initializes masked alternative routes and exposes role routing policy", async () => {
    makeConfig(tmp, {
      provider: "openai",
      model: "primary-model",
      apiKey: "primary-secret",
      alternativeRoutes: [{ id: "backup", provider: "anthropic", model: "backup-model", apiKey: "backup-secret" }],
      rolePolicies: { observer: { routeIds: ["primary", "backup"], timeoutMs: 12_000 } },
    });
    const svc = service(tmp, { createProvider: (config) => ({
        async extractJson() { return { model: config.model }; },
        async runTools() { throw new Error("not used"); },
      }),
    });
    const view = svc.initializeFromConfig();
    expect(view.alternativeRoutes).toEqual([
      expect.objectContaining({ id: "backup", model: "backup-model", apiKeyMasked: "••••••••" }),
    ]);
    expect(JSON.stringify(view)).not.toContain("backup-secret");
    expect(readFileSync(join(tmp, "llm.json"), "utf8")).not.toContain("backup-secret");
    expect(svc.getRolePolicies().observer).toMatchObject({ routeIds: ["primary", "backup"], timeoutMs: 12_000 });
    expect(await svc.getModelRoutes().get("backup")!.extractJson({ system: "", user: "", schema: {} }))
      .toEqual({ model: "backup-model" });
  });

  it("handles missing apiKey in config", () => {
    makeConfig(tmp, { provider: "openai", model: "m" });
    const svc = service(tmp);
    const cfg = svc.load();
    expect(cfg.apiKeyMasked).toBe("");
  });

  it("propagates provider creation errors during reload when apiKey is missing", () => {
    makeConfig(tmp, { provider: "openai", model: "m" });
    const svc = service(tmp);
    expect(() => svc.reload({ provider: "openai", model: "m" })).toThrow(/apiKey is missing/);
  });

  it("tests config connectivity when provider confirms", async () => {
    const realConfig = loadLlmConfig(resolve("config/llm.json"));
    if (!realConfig) throw new Error("real LLM config is required for connectivity tests");
    makeConfig(tmp, realConfig);
    const svc = service(tmp);
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
