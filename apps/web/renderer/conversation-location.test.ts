import { expect, it } from "vitest";
import { readConversationLocation, saveConversationLocation } from "./conversation-location";
it("restores only a validated view identity and can explicitly start a new conversation", () => {
  const rows = new Map<string, string>(), storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); } };
  expect(readConversationLocation(storage)).toBeNull(); saveConversationLocation(storage, "conversation_1"); expect(readConversationLocation(storage)).toBe("conversation_1");
  saveConversationLocation(storage, null); expect(readConversationLocation(storage)).toBeNull();
  expect(() => saveConversationLocation(storage, "../../elsewhere")).toThrow();
  expect(() => readConversationLocation({ ...storage, getItem: () => "x".repeat(101) })).toThrow();
});
