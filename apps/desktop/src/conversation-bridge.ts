import { DesktopEvidenceReadSchema } from "@traceforge/shared/desktop-evidence";
import { parseDesktopExecutionOperation, DesktopApprovalReadSchema } from "@traceforge/shared/desktop-execution";

/** Narrow, credential-free IPC contract; this is not an arbitrary HTTP proxy. */
export interface ConversationBridgeRequest { path: string; method: "GET" | "POST"; body?: string }
export interface ConversationBridgeReply { status: number; body: unknown }
export interface BridgeSender { webContentsId: number; mainFrame: boolean; url: string }
export interface ConversationBridgeHost {
  request(input: ConversationBridgeRequest): Promise<ConversationBridgeReply>;
}

export function validateConversationRequest(value: unknown): ConversationBridgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid conversation request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["path", "method", "body"].includes(key)) || typeof input.path !== "string" ||
      input.path.length > 256 || !["GET", "POST"].includes(String(input.method))) throw new Error("Invalid conversation request");
  const method = input.method as "GET" | "POST";
  const path = input.path;
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/execution\/approval-input$/.test(path)) {
    if (method !== "POST" || typeof input.body !== "string" || Buffer.byteLength(input.body) > 4096) throw new Error("Invalid approval preview");
    return { path, method, body: JSON.stringify(DesktopApprovalReadSchema.parse(JSON.parse(input.body))) };
  }
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/execution\/[a-zA-Z0-9_-]{1,100}\/events\?after=(0|[1-9][0-9]{0,14})$/.test(path)) {
    if (method !== "GET" || input.body !== undefined) throw new Error("Invalid progress read");
    return { path, method };
  }
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/evidence\/read$/.test(path)) {
    if (method !== "POST" || typeof input.body !== "string" || Buffer.byteLength(input.body) > 2048) throw new Error("Invalid evidence read");
    return { path, method, body: JSON.stringify(DesktopEvidenceReadSchema.parse(JSON.parse(input.body))) };
  }
  const execution = /^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/execution(\/(authorize|cancel|approval|input))?$/.exec(path);
  if (execution) {
    if (method === "GET") {
      if (execution[1] || input.body !== undefined) throw new Error("Invalid execution read");
      return { path, method };
    }
    if (typeof input.body !== "string" || Buffer.byteLength(input.body) > 40000) throw new Error("Invalid execution body");
    const operation = parseDesktopExecutionOperation({ path, body: JSON.parse(input.body) }, path.split("/")[4]!);
    return { path, method, body: JSON.stringify(operation.body) };
  }
  const root = "/api/desktop/conversations";
  const collection = path === root;
  const detail = /^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}$/.test(path);
  const messages = /^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/messages$/.test(path);
  const page = /^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/messages\?after=(0|[1-9][0-9]{0,3})&limit=100$/.test(path);
  if (!(method === "GET" ? collection || detail || messages || page : collection || messages)) throw new Error("Conversation operation not allowed");
  if (method === "GET") {
    if (input.body !== undefined) throw new Error("GET body not allowed");
    return { path, method };
  }
  if (typeof input.body !== "string" || Buffer.byteLength(input.body) > 100000) throw new Error("Invalid conversation body");
  let body: unknown;
  try { body = JSON.parse(input.body); } catch { throw new Error("Invalid conversation body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid conversation body");
  const data = body as Record<string, unknown>;
  const field = collection ? "title" : "text";
  if (Object.keys(data).length !== 2 || Object.keys(data).some(key => key !== "commandId" && key !== field) ||
      typeof data.commandId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.commandId) ||
      typeof data[field] !== "string" || !(data[field] as string).trim() ||
      (data[field] as string).length > (collection ? 200 : 16000)) throw new Error("Invalid conversation body");
  return { path, method, body: JSON.stringify(data) };
}

export function createConversationBridge(options: { webContentsId: number; origin: string; host: ConversationBridgeHost }) {
  const expected = new URL(options.origin);
  if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1" || expected.username || expected.password || expected.pathname !== "/") throw new Error("Bridge requires local host origin");
  let active = true; let inFlight = 0;
  return {
    close() { active = false; },
    async request(sender: BridgeSender, value: unknown): Promise<ConversationBridgeReply> {
      let url: URL;
      try { url = new URL(sender.url); } catch { throw new Error("Untrusted conversation sender"); }
      if (!active || sender.webContentsId !== options.webContentsId || !sender.mainFrame || url.origin !== expected.origin ||
          url.username || url.password || url.pathname !== "/") throw new Error("Untrusted conversation sender");
      const input = validateConversationRequest(value);
      if (inFlight >= 4) throw new Error("Conversation bridge busy");
      inFlight++;
      try {
        const reply = await options.host.request(input);
        if (!active) throw new Error("Conversation bridge closed");
        return reply;
      } finally { inFlight--; }
    },
  };
}
