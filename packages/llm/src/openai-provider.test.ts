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

  it("reports usage via onUsage for extractJson", async () => {
    const provider = new OpenAICompatibleProvider({ apiKey: "test", model: "m" });
    const holder = provider as unknown as {
      client: { chat: { completions: { create: (args: unknown) => Promise<unknown> } } };
    };
    holder.client.chat.completions.create = async () => ({
      choices: [{ message: { content: "{\"warnings\":[]}" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const usages: { promptTokens: number; completionTokens: number; totalTokens: number }[] = [];
    await provider.extractJson({
      system: "sys",
      user: "user",
      schema: { type: "object", properties: { warnings: { type: "array" } } },
      onUsage: (u) => usages.push(u),
    });

    expect(usages).toEqual([{ promptTokens: 10, completionTokens: 5, totalTokens: 15 }]);
  });

  it("reports usage via onUsage for runTools", async () => {
    const provider = new OpenAICompatibleProvider({ apiKey: "test", model: "m" });
    const holder = provider as unknown as {
      client: { chat: { completions: { create: (args: unknown) => Promise<unknown> } } };
    };
    holder.client.chat.completions.create = async () => ({
      choices: [{ message: { content: "ok", tool_calls: [], finish_reason: "stop" } }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
    });

    const usages: { promptTokens: number; completionTokens: number; totalTokens: number }[] = [];
    await provider.runTools({
      system: "sys",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      onUsage: (u) => usages.push(u),
    });

    expect(usages).toEqual([{ promptTokens: 20, completionTokens: 3, totalTokens: 23 }]);
  });

  it("reports usage via onUsage for streamTools", async () => {
    const provider = new OpenAICompatibleProvider({ apiKey: "test", model: "m" });
    const holder = provider as unknown as {
      client: { chat: { completions: { create: (args: unknown, options?: unknown) => Promise<AsyncIterable<unknown>> } } };
    };
    holder.client.chat.completions.create = async () => {
      const chunks = [
        { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
    };

    const usages: { promptTokens: number; completionTokens: number; totalTokens: number }[] = [];
    await provider.streamTools(
      { system: "sys", messages: [{ role: "user", content: "go" }], tools: [] },
      { onUsage: (u) => usages.push(u) },
    );

    expect(usages).toEqual([{ promptTokens: 7, completionTokens: 1, totalTokens: 8 }]);
  });
});
