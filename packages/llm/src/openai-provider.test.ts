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
});
