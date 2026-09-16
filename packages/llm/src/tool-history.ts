import { createHash } from "node:crypto";
import type { TurnMessage } from "./provider.js";

/** A request-only projection. Never rewrite persisted calls/receipts, manufacture
 * missing results or execute tools while converting between wire protocols. */
export function normalizeToolHistory(messages: readonly TurnMessage[]): TurnMessage[] {
  const pending = new Map<string, string>();
  const used = new Set<string>();
  const wireIds = new Set<string>();
  const result = messages.map(message => {
    if(message.attachments?.length && message.role!=="user")throw new Error("Attachments require a user message");
    if (message.role === "tool") {
      const id = message.toolCallId && pending.get(message.toolCallId);
      if (!id || message.toolCalls?.length) throw new Error("Tool result has no matching call");
      pending.delete(message.toolCallId!);
      return { ...message, toolCallId: id };
    }
    if (pending.size) throw new Error("Tool results are missing");
    if (!message.toolCalls?.length) return { ...message };
    if (message.role !== "assistant") throw new Error("Invalid tool call history");
    return { ...message, toolCalls: message.toolCalls.map(call => {
      if (!call.id || used.has(call.id)) throw new Error("Invalid or duplicate tool call identity");
      used.add(call.id);
      // Keep portable IDs unchanged; reserve the prefix to avoid collision with a
      // native ID which happens to resemble an encoded foreign ID.
      const id = /^[a-zA-Z0-9_-]{1,64}$/.test(call.id) && !call.id.startsWith("tfh_")
        ? call.id : `tfh_${createHash("sha256").update(call.id).digest("hex").slice(0, 60)}`;
      if (wireIds.has(id)) throw new Error("Tool history identity collision");
      wireIds.add(id); pending.set(call.id, id);
      return { ...call, id };
    }) };
  });
  if (pending.size) throw new Error("Tool results are missing");
  return result;
}
