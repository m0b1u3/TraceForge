import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "./openai-provider.js";

describe("OpenAICompatibleProvider retry integration", () => {
  it("retries transient runTools failures and reports retry notices", async () => {
    const provider = new OpenAICompatibleProvider({ apiKey: "test", model: "m", baseUrl: "https://example.invalid" });
    const holder = provider as unknown as {
      client: { chat: { completions: { create: (args: unknown) => Promise<unknown> } } };
    };
    let attempts = 0;
    holder.client.chat.completions.create = async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("rate limited") as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      return { choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }] };
    };

    const notices: Array<{ attempt: number; maxAttempts: number; reason: string }> = [];
    const result = await provider.runTools({
      system: "sys",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      onRetry: (notice) => notices.push(notice),
    });

    expect(result.text).toBe("ok");
    expect(attempts).toBe(2);
    expect(notices).toEqual([{ attempt: 2, maxAttempts: 3, reason: "rate limited" }]);
  });
});
