import { expect, it, vi } from "vitest";
import { withContextBudget } from "./context-budget-provider.js";
import type { LlmProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";

it("does not reject input against an invented window when supplier metadata is unknown",async()=>{
  const raw:LlmProvider={extractJson:vi.fn(async()=>({ok:true})),runTools:vi.fn()};
  await expect(withContextBudget(raw,{}).extractJson({system:"Task",user:"x".repeat(200000),schema:{}})).resolves.toEqual({ok:true});
  expect(raw.extractJson).toHaveBeenCalledOnce();
});
it("does not manufacture a required Anthropic output value",async()=>{
  const fetch=vi.fn();const model=new AnthropicProvider({model:"unknown",apiKey:"fixture",fetch});
  await expect(model.extractJson({system:"JSON",user:"hello",schema:{}})).rejects.toThrow("requires max_tokens");
  expect(fetch).not.toHaveBeenCalled();
});

it("guards the complete request and calibrates from real input usage without treating cache as free context", async () => {
  const onUsage = vi.fn();
  const raw: LlmProvider = { extractJson: vi.fn(async args => {
    args.onUsage?.({ promptTokens: 1000, completionTokens: 10, totalTokens: 1010 }); return {};
  }), runTools: vi.fn() };
  const provider = withContextBudget(raw, { contextWindowTokens: 32000, maxOutputTokens: 4000 });
  await provider.extractJson({ system: "s", user: "x".repeat(1000), schema: {}, onUsage });
  expect(onUsage).toHaveBeenCalledTimes(1);
  expect(provider.contextLimits?.inputTokenMultiplier).toBeGreaterThan(1);
  expect(() => provider.extractJson({ system: "x".repeat(100000), user: "", schema: {} })).toThrow("budget");
  expect(raw.extractJson).toHaveBeenCalledTimes(1);
});
it("does not expose streaming or embedding when the underlying provider lacks them", () => {
  const provider = withContextBudget({ extractJson: vi.fn(), runTools: vi.fn() }, {});
  expect(provider.streamTools).toBeUndefined(); expect(provider.embed).toBeUndefined();
  expect(provider.contextLimits?.contextWindowTokens).toBeUndefined();
});
it("Anthropic honors configured output and includes cached input in context usage", async () => {
  let body: any;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "message", type: "message", role: "assistant", model: "fixture", content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 2 } }),
    { headers: { "content-type": "application/json" } });
  };
  const provider = new AnthropicProvider({ model: "fixture", apiKey: "test", maxOutputTokens: 512, fetch });
  const onUsage = vi.fn();
  await provider.extractJson({ system: "s", user: "u", schema: {}, onUsage });
  expect(body.max_tokens).toBe(512);
  expect(onUsage).toHaveBeenCalledWith({ promptTokens: 60, completionTokens: 2, totalTokens: 62 });
});
