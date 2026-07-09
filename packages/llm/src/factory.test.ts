import { describe, it, expect } from "vitest";
import { createProvider, createProviderFromConfig } from "./factory.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatibleProvider } from "./openai-provider.js";

describe("createProvider", () => {
  it("builds an AnthropicProvider for provider=anthropic", () => {
    const p = createProvider({ provider: "anthropic", model: "m", apiKey: "sk-x" });
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it("builds an OpenAICompatibleProvider for provider=openai", () => {
    const p = createProvider({ provider: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", apiKey: "sk-x" });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("passes JSON mode to OpenAICompatibleProvider", () => {
    const p = createProvider({
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-x",
      jsonMode: "json_object",
    });
    const holder = p as unknown as { opts: { jsonMode?: string } };
    expect(holder.opts.jsonMode).toBe("json_object");
  });

  it("throws when the api key is missing", () => {
    expect(() => createProvider({ provider: "anthropic", model: "m" })).toThrow(/apiKey is missing/);
  });
});

describe("createProviderFromConfig", () => {
  it("throws when config is null", () => {
    expect(() => createProviderFromConfig(null)).toThrow("LLM config missing");
  });

  it("throws when the api key is missing", () => {
    expect(() => createProviderFromConfig({ provider: "anthropic", model: "m" })).toThrow(/apiKey is missing/);
  });
});
