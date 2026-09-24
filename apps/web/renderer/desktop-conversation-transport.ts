import type { ConversationTransport } from "./conversation-client";

/** The bridge is supplied by an isolated Electron preload, never by URL config. */
export interface DesktopConversations {
  protocolVersion: 1;
  subscribeReplyDelta?(listener: (event: { conversationId: string; messageId: string; kind: "text" | "reasoning"; offset: number; delta: string }) => void): () => void;
  selectAttachments?():Promise<unknown>;
  storage?(operation: "inspect" | "open-data" | "open-logs" | "clear-cache"): Promise<unknown>;
  presentBrowser?(input: { hide: true } | { path: string; sessionId: string; takeoverId: string | null; focus?: boolean;
    bounds: { x: number; y: number; width: number; height: number } }): Promise<{ url?: string; title?: string; hidden?: boolean }>;
  request(input: { path: string; method: "GET" | "POST"; body?: string }): Promise<{ status: number; body: unknown }>;
}
export function desktopConversationTransport(bridge: DesktopConversations): ConversationTransport {
  if (bridge.protocolVersion !== 1 || typeof bridge.request !== "function") throw new Error("Unsupported desktop conversation bridge");
  return async (path, init) => {
    if (init.signal?.aborted) throw new Error("Conversation request cancelled");
    // AbortSignal cannot cross contextBridge; cancellation hides a late result,
    // but does not claim to cancel a host transaction already committed.
    const response = await bridge.request({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    if (init.signal?.aborted) throw new Error("Conversation request cancelled; host outcome must be reconciled");
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error("Invalid desktop response");
    return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body };
  };
}
