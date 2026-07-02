import { describe, it, expect, afterEach } from "vitest";
import { createProvider, createProviderOrMock } from "./factory.js";
import { MockProvider } from "./mock-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatibleProvider } from "./openai-provider.js";

const KEY = "TF_TEST_LLM_KEY";
afterEach(() => { delete process.env[KEY]; });

describe("createProvider", () => {
  it("builds an AnthropicProvider for provider=anthropic", () => {
    process.env[KEY] = "sk-x";
    const p = createProvider({ provider: "anthropic", model: "m", apiKeyEnv: KEY });
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it("builds an OpenAICompatibleProvider for provider=openai", () => {
    process.env[KEY] = "sk-x";
    const p = createProvider({ provider: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", apiKeyEnv: KEY });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("passes JSON mode to OpenAICompatibleProvider", () => {
    process.env[KEY] = "sk-x";
    const p = createProvider({
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: KEY,
      jsonMode: "json_object",
    });
    const holder = p as unknown as { opts: { jsonMode?: string } };
    expect(holder.opts.jsonMode).toBe("json_object");
  });

  it("throws when the api key env var is missing", () => {
    expect(() => createProvider({ provider: "anthropic", model: "m", apiKeyEnv: KEY })).toThrow();
  });
});

describe("createProviderOrMock", () => {
  it("returns a MockProvider when config is null", () => {
    expect(createProviderOrMock(null)).toBeInstanceOf(MockProvider);
  });

  it("returns a MockProvider when the api key is missing", () => {
    expect(createProviderOrMock({ provider: "anthropic", model: "m", apiKeyEnv: KEY })).toBeInstanceOf(MockProvider);
  });
});
