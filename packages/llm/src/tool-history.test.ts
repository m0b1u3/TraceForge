import { expect, it } from "vitest";
import { normalizeToolHistory } from "./tool-history.js";
import type { TurnMessage } from "./provider.js";

it("projects long foreign IDs and paired results without changing original receipts", () => {
  const foreign = "call|" + "x".repeat(450);
  const messages: TurnMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ id: foreign, name: "read", input: {} }, { id: "portable", name: "read", input: {} }] },
    { role: "tool", content: "first", toolCallId: foreign },
    { role: "tool", content: "second", toolCallId: "portable" },
  ];
  const before = JSON.stringify(messages), result = normalizeToolHistory(messages);
  expect(result[0].toolCalls![0].id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(result[1].toolCallId).toBe(result[0].toolCalls![0].id);
  expect(result[2].toolCallId).toBe("portable");
  expect(normalizeToolHistory(messages)).toEqual(result);
  expect(JSON.stringify(messages)).toBe(before);
});
it("rejects incomplete, orphan and duplicate history instead of inventing results", () => {
  const call: TurnMessage = { role: "assistant", content: "", toolCalls: [{ id: "one", name: "read", input: {} }] };
  const result: TurnMessage = { role: "tool", content: "saved", toolCallId: "one" };
  for (const messages of [[call], [result], [call, { role: "user" as const, content: "next" }], [call, result, result], [call, result, call, result]])
    expect(() => normalizeToolHistory(messages)).toThrow();
});
it("does not confuse a native ID with a generated ID", () => {
  const make = (id: string): TurnMessage[] => [{role:"assistant",content:"",toolCalls:[{id,name:"read",input:{}}]}, {role:"tool",content:"ok",toolCallId:id}];
  const encoded = normalizeToolHistory(make("foreign|id"))[1].toolCallId!;
  const result = normalizeToolHistory([...make("foreign|id"), ...make(encoded)]);
  expect(result[1].toolCallId).not.toBe(result[3].toolCallId);
});
