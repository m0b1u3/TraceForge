import { DesktopEvidenceReadSchema } from "@traceforge/shared/desktop-evidence";
import { DesktopBrowserCommandSchema } from "@traceforge/shared/desktop-browser";
import { ApprovalPreferenceUpdateSchema } from "@traceforge/shared/desktop-approval-preference";
import { RequestScheduler } from "./request-scheduler.js";
import { DesktopReplyCommandSchema } from "@traceforge/shared/desktop-replies";
import {ReplyQueueCommandSchema} from "@traceforge/shared/desktop-reply-queue";
import { ConfigurationSaveSchema, ConfigurationImportSchema } from "@traceforge/shared/desktop-configuration";
import { DesktopMcpOperationSchema } from "@traceforge/shared/desktop-mcp";
import { DesktopResourceOperationSchema } from "@traceforge/shared/desktop-resources";
import { parseDesktopExecutionOperation, DesktopApprovalReadSchema, DesktopPermissionChangeSchema } from "@traceforge/shared/desktop-execution";

/** Narrow host-management IPC; credentials are write-only, never an arbitrary HTTP proxy. */
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
  if (path === "/api/desktop/task-definitions") {
    if (method !== "GET" || input.body !== undefined) throw new Error("Invalid task definitions read");
    return { path, method };
  }
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/execution\/[a-zA-Z0-9_-]{1,100}\/browser$/.test(path)) {
    if (method === "GET" && input.body === undefined) return { path, method };
    if (method !== "POST" || typeof input.body !== "string" || Buffer.byteLength(input.body) > 40000) throw new Error("Invalid browser command");
    return { path, method, body: JSON.stringify(DesktopBrowserCommandSchema.parse(JSON.parse(input.body))) };
  }
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/attachments\/preview$/.test(path)) {
    if(method!=="POST"||typeof input.body!=="string"||input.body.length>1024)throw new Error("Invalid attachment preview");
    return {path,method,body:JSON.stringify(AttachmentPreviewRequestSchema.parse(JSON.parse(input.body)))};
  }
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/reply-queue$/.test(path)) {
    if(method==="GET"&&input.body===undefined)return {path,method};
    if(method!=="POST"||typeof input.body!=="string"||Buffer.byteLength(input.body)>70000)throw new Error("Invalid queue command");
    return {path,method,body:JSON.stringify(ReplyQueueCommandSchema.parse(JSON.parse(input.body)))};
  }
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/replies\/[a-zA-Z0-9_-]{1,100}\/memory$/.test(path)) {
    if (method !== "GET" || input.body !== undefined) throw new Error("Invalid memory read");
    return { path, method };
  }
  if (path === "/api/desktop/approval-preference") {
    if (method === "GET" && input.body === undefined) return { path, method };
    if (method !== "POST" || typeof input.body !== "string" || Buffer.byteLength(input.body) > 1024) throw new Error("Invalid approval preference");
    return { path, method, body: JSON.stringify(ApprovalPreferenceUpdateSchema.parse(JSON.parse(input.body))) };
  }
  if (path === "/api/desktop/resources") {
    if (method === "GET" && input.body === undefined) return { path, method };
    if (method !== "POST" || typeof input.body !== "string" || Buffer.byteLength(input.body) > 96 * 1024) throw new Error("Invalid resource operation");
    return { path, method, body: JSON.stringify(DesktopResourceOperationSchema.parse(JSON.parse(input.body))) };
  }
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/replies\?after=(0|[1-9][0-9]{0,15})$/.test(path)) {
    const cursor = Number(path.split("after=")[1]);
    if (method !== "GET" || input.body !== undefined || !Number.isSafeInteger(cursor)) throw new Error("Invalid reply read");
    return { path, method };
  }
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/replies\/[a-zA-Z0-9_-]{1,100}(\/cancel)?$/.test(path)) {
    if (method !== "POST" || typeof input.body !== "string" || input.body.length > 2048) throw new Error("Invalid reply command");
    const command = DesktopReplyCommandSchema.parse(JSON.parse(input.body));
    return { path, method, body: JSON.stringify(command) };
  }
  if(path === "/api/desktop/configuration/import") {
    if(method!=="POST"||typeof input.body!=="string"||Buffer.byteLength(input.body)>4096)throw new Error("Invalid configuration import");
    return {path,method,body:JSON.stringify(ConfigurationImportSchema.parse(JSON.parse(input.body)))};
  }
  if (path === "/api/desktop/mcp") {
    if (method === "GET" && input.body === undefined) return { path,method };
    if (method !== "POST" || typeof input.body !== "string" || Buffer.byteLength(input.body)>128*1024) throw new Error("Invalid MCP operation");
    return {path,method,body:JSON.stringify(DesktopMcpOperationSchema.parse(JSON.parse(input.body)))};
  }
  if (path === "/api/desktop/configuration") {
    if (method === "GET" && input.body === undefined) return { path, method };
    if (method !== "POST" || typeof input.body !== "string" || Buffer.byteLength(input.body) > 600 * 1024) throw new Error("Invalid configuration request");
    return { path, method, body: JSON.stringify(ConfigurationSaveSchema.parse(JSON.parse(input.body))) };
  }
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
  if (/^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/execution\/[a-zA-Z0-9_-]{1,100}\/permissions$/.test(path)) {
    if(method==="GET" && input.body===undefined)return {path,method};
    if(method!=="POST" || typeof input.body!=="string" || Buffer.byteLength(input.body)>40000)throw new Error("Invalid permission change");
    return {path,method,body:JSON.stringify(DesktopPermissionChangeSchema.parse(JSON.parse(input.body)))};
  }
  const execution = /^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/execution(\/(authorize|cancel|pause|resume|continue|approval|input))?$/.exec(path);
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
  const collectionPage = /^\/api\/desktop\/conversations\?offset=(0|[1-9][0-9]{0,15})$/.test(path);
  const detail = /^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}$/.test(path);
  const messages = /^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/messages$/.test(path);
  const page = /^\/api\/desktop\/conversations\/[a-zA-Z0-9_-]{1,100}\/messages\?after=(0|[1-9][0-9]{0,3})&limit=100$/.test(path);
  if (!(method === "GET" ? collection || collectionPage || detail || messages || page : collection || messages)) throw new Error("Conversation operation not allowed");
  if (method === "GET") {
    if (input.body !== undefined) throw new Error("GET body not allowed");
    return { path, method };
  }
  if (typeof input.body !== "string" || Buffer.byteLength(input.body) > 3200000) throw new Error("Invalid conversation body");
  let body: unknown;
  try { body = JSON.parse(input.body); } catch { throw new Error("Invalid conversation body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid conversation body");
  const data = body as Record<string, unknown>;
  const field = collection ? "title" : "text";
  if (Object.keys(data).some(key => key !== "commandId" && key !== field && (collection || key !== "attachments")) ||
      typeof data.commandId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.commandId) ||
      typeof data[field] !== "string" || !(data[field] as string).trim() ||
      (data[field] as string).length > (collection ? 200 : 16000)) throw new Error("Invalid conversation body");
  if(data.attachments!==undefined)MessageAttachmentsSchema.parse(data.attachments);
  return { path, method, body: JSON.stringify(data) };
}

export function createConversationBridge(options: { webContentsId: number; origin: string; host: ConversationBridgeHost; scheduler?: RequestScheduler }) {
  const expected = new URL(options.origin);
  if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1" || expected.username || expected.password || expected.pathname !== "/") throw new Error("Bridge requires local host origin");
  let active = true;
  const scheduler = options.scheduler ?? new RequestScheduler();
  return {
    close() { active = false; scheduler.close(); },
    async request(sender: BridgeSender, value: unknown): Promise<ConversationBridgeReply> {
      let url: URL;
      try { url = new URL(sender.url); } catch { throw new Error("Untrusted conversation sender"); }
      if (!active || sender.webContentsId !== options.webContentsId || !sender.mainFrame || url.origin !== expected.origin ||
          url.username || url.password || url.pathname !== "/") throw new Error("Untrusted conversation sender");
      const input = validateConversationRequest(value);
      const read = input.method === "GET" || /\/(evidence\/read|attachments\/preview|execution\/approval-input)$/.test(input.path);
      const urgent = input.method === "POST" && /\/(cancel|pause|resume|approval)$/.test(input.path);
      return scheduler.schedule(!read, async () => {
        if (!active) throw new Error("Conversation bridge closed");
        const reply = await options.host.request(input);
        if (!active) throw new Error("Conversation bridge closed");
        return reply;
      }, input.method === "GET" ? input.path : undefined, urgent);
    },
  };
}
import { MessageAttachmentsSchema,AttachmentPreviewRequestSchema } from "@traceforge/shared/message-attachments";
