import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "./openai-provider.js";

describe("OpenAICompatibleProvider extractJson compatibility", () => {
  it("falls back to prompt-only JSON when json_schema response_format is unavailable", async () => {
    const provider = new OpenAICompatibleProvider({ apiKey: "test", model: "m", baseUrl: "https://example.invalid" });
    const holder = provider as unknown as {
      client: { chat: { completions: { create: (args: unknown) => Promise<unknown> } } };
    };
    const calls: unknown[] = [];
    holder.client.chat.completions.create = async (args: unknown) => {
      calls.push(args);
      if (calls.length === 1) {
        const err = new Error("This response_format type is unavailable now") as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      return { choices: [{ message: { content: "{\"warnings\":[]}" } }] };
    };

    const result = await provider.extractJson({
      system: "sys",
      user: "user",
      schema: { type: "object", properties: { warnings: { type: "array" } } },
    });

    expect(result).toEqual({ warnings: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ response_format: { type: "json_schema" } });
    expect(calls[1]).not.toHaveProperty("response_format");
  });

  it("uses json_object response format and JSON prompt guidance when configured", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      jsonMode: "json_object",
    });
    const holder = provider as unknown as {
      client: { chat: { completions: { create: (args: unknown) => Promise<unknown> } } };
    };
    const calls: unknown[] = [];
    holder.client.chat.completions.create = async (args: unknown) => {
      calls.push(args);
      return { choices: [{ message: { content: "{\"warnings\":[]}" } }] };
    };

    const result = await provider.extractJson({
      system: "sys",
      user: "user",
      schema: { type: "object", properties: { warnings: { type: "array" } }, required: ["warnings"] },
    });

    expect(result).toEqual({ warnings: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ response_format: { type: "json_object" } });
    const messages = (calls[0] as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[0].content.toLowerCase()).toContain("json");
    expect(messages[0].content).toContain("\"warnings\"");
  });

  it("retries empty json_object content", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      jsonMode: "json_object",
    });
    const holder = provider as unknown as {
      client: { chat: { completions: { create: (args: unknown) => Promise<unknown> } } };
    };
    let attempts = 0;
    holder.client.chat.completions.create = async () => {
      attempts += 1;
      if (attempts === 1) return { choices: [{ message: { content: "" } }] };
      return { choices: [{ message: { content: "{\"warnings\":[]}" } }] };
    };

    await expect(provider.extractJson({
      system: "sys",
      user: "user",
      schema: { type: "object", properties: { warnings: { type: "array" } } },
    })).resolves.toEqual({ warnings: [] });
    expect(attempts).toBe(2);
  });

});
