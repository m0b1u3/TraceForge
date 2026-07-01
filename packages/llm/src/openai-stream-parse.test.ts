import { describe, it, expect } from "vitest";
import { assembleOpenAIStreamChoice } from "./openai-provider.js";

describe("assembleOpenAIStreamChoice", () => {
  it("assembles text and fragmented tool call arguments", () => {
    const out = assembleOpenAIStreamChoice([
      { choices: [{ delta: { content: "hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "{\"q\"" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":\"x\"}" } }] }, finish_reason: "tool_calls" }] },
    ] as never);
    expect(out.text).toBe("hello");
    expect(out.toolCalls).toEqual([{ id: "call_1", name: "search", input: { q: "x" } }]);
    expect(out.done).toBe(false);
  });
});
