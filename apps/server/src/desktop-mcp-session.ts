import { randomUUID, createHash } from "node:crypto";
import { BrokeredHttpGateway, type BrokeredHttpTransport, type ExecutionAttribution, type BrokeredNetworkReceipt } from "@traceforge/execution-node";
import { canonicalJson, type EffectivePermissionProfile } from "@traceforge/orchestration-core";
import type { McpCatalog, McpConnection } from "@traceforge/shared/desktop-mcp";

export const mcpDigest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

/** Runs only behind BrokeredHttpGateway's exact endpoint grant. Stop SSE after the matching response. */
function httpTransport(signal?:AbortSignal):BrokeredHttpTransport{return async request=>{
  const response=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body?new Uint8Array(request.body):undefined,redirect:"manual",signal:AbortSignal.any([AbortSignal.timeout(request.timeoutMs),...(signal?[signal]:[])])});
  const headers=[...response.headers.entries()].map(([name,value])=>({name,value}));
  const reader=response.body?.getReader();if(!reader)return {status:response.status,headers,body:Buffer.alloc(0),bodyTruncated:false};
  const chunks:Buffer[]=[];let bytes=0,truncated=false;
  const expected=request.body?JSON.parse(request.body.toString()).id:undefined;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>request.responseLimitBytes){truncated=true;break;}chunks.push(Buffer.from(part.value));
    if(response.headers.get("content-type")?.includes("text/event-stream")){
      const completed=Buffer.concat(chunks).toString("utf8").split(/\r?\n\r?\n/).slice(0,-1);
      if(completed.some(block=>{const data=block.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trimStart()).join("\n");if(!data)return false;const value=JSON.parse(data);return value.id===expected||value.method&&value.id!==undefined;}))break;
    }
  }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return {status:response.status,headers,body:Buffer.concat(chunks),bodyTruncated:truncated};
};}

/** A single bounded session to one operator-approved endpoint. No redirects, reverse RPC or automatic retry. */
export class DesktopMcpSession {
  async close():Promise<void> { /* HTTP requests have no retained process; response streams are cancelled by transport. */ }
  private sessionId: string | undefined;
  private readonly broker: BrokeredHttpGateway;
  readonly receipts: BrokeredNetworkReceipt[] = [];
  private readonly permissions: EffectivePermissionProfile = { version: 1, platform: "darwin", filesystem: { read: [], write: [], deny: [] },
    network: "brokered", process: { access: "deny", interactive: false, background: false }, secrets: "handles_only", sources: ["desktop-mcp-endpoint-grant"] };
  constructor(private readonly connection: McpConnection, private readonly credential: string | undefined,
    private readonly attribution: ExecutionAttribution, private readonly authorize: () => void,
    transport?: BrokeredHttpTransport, private readonly signal?: AbortSignal) {
    this.broker = new BrokeredHttpGateway({ transport:transport??httpTransport(signal), limits: { maximumRequestBytes: 65536, maximumResponseBytes: 262144, maximumTimeoutMs: 15000, maximumConcurrentRequests: 1 },
      authorizer: { authorize: ({ url }) => { this.check(); if (url !== new URL(connection.endpoint).href) throw new Error("MCP endpoint changed");
        return { canonicalUrl: url, authorizationRef: `desktop-mcp:${connection.id}`, expiresAt: attribution.leaseExpiresAt }; } } });
  }
  private check() { this.signal?.throwIfAborted(); this.authorize(); }
  async rpc(method: string, params: unknown = {}, notification = false): Promise<any> {
    this.check();
    const id = randomUUID();
    const response = await this.broker.execute("desktop-mcp", { requestId: id,
      attribution: { ...this.attribution, idempotencyKey: `${this.attribution.idempotencyKey}:${id}` }, permissions: this.permissions,
      authorizationAction: this.connection.authorizationAction, url: this.connection.endpoint, method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}), ...(this.credential ? { authorization: `Bearer ${this.credential}` } : {}) },
      bodyBase64: Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params })).toString("base64"),
      timeoutMs: 15000, responseLimitBytes: 262144 });
    this.check(); this.receipts.push(response.receipt);
    if (response.status < 200 || response.status >= 300 || response.bodyTruncated) throw new Error("MCP HTTP request failed or exceeded its response limit");
    const session = response.headers.find(h => h.name.toLowerCase() === "mcp-session-id")?.value;
    if (session) { if (session.length > 512 || /[^\x21-\x7e]/.test(session) || this.sessionId && this.sessionId !== session) throw new Error("MCP session identity changed"); this.sessionId = session; }
    if (notification) return;
    const original = Buffer.from(response.bodyBase64, "base64").toString("utf8");
    const body = this.credential ? original.split(this.credential).join("[REDACTED]") : original;
    let messages: unknown[];
    if (response.headers.some(h => h.name.toLowerCase() === "content-type" && h.value.includes("text/event-stream"))) {
      messages = body.split(/\r?\n\r?\n/).filter(part => /^data:/m.test(part)).map(part => JSON.parse(part.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")));
    } else messages = [JSON.parse(body)];
    if (messages.some(m => !object(m) || m.jsonrpc !== "2.0" || m.method && m.id !== undefined)) throw new Error("Unnegotiated MCP reverse request");
    const replies = messages.filter(m => object(m) && m.id === id) as Record<string, any>[];
    if (replies.length !== 1 || replies[0]!.error || !("result" in replies[0]!)) throw new Error("Invalid MCP response");
    return replies[0]!.result;
  }
  async discover(): Promise<McpCatalog> {
    const hello = await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "traceforge", version: "1" } });
    if (!object(hello) || hello.protocolVersion !== "2025-03-26" || !object(hello.serverInfo) || !object(hello.capabilities?.tools)
      || typeof hello.serverInfo.name !== "string" || !hello.serverInfo.name || hello.serverInfo.name.length > 256
      || typeof hello.serverInfo.version !== "string" || !hello.serverInfo.version || hello.serverInfo.version.length > 256) throw new Error("MCP initialization contract mismatch");
    await this.rpc("notifications/initialized", {}, true);
    const result = await this.rpc("tools/list");
    if (!object(result) || !Array.isArray(result.tools) || result.tools.length > 128 || result.nextCursor !== undefined) throw new Error("MCP catalog exceeds supported bounds");
    const tools = result.tools.map((t: unknown) => {
      if (!object(t) || typeof t.name !== "string" || !t.name || t.name.length > 256 || !object(t.inputSchema) || t.inputSchema.type !== "object") throw new Error("Invalid MCP tool schema");
      return { name: t.name, inputSchema: t.inputSchema };
    });
    if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error("Duplicate MCP tool name");
    const data = { serverName: hello.serverInfo.name, serverVersion: hello.serverInfo.version, tools };
    return { ...data, digest: mcpDigest(data) };
  }
}
