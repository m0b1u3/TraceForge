import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import { openProcessNetworkEndpoint, resolveNetworkDestination, requestPinnedHttp, connectPinnedTcp, upgradePinnedWebSocket, type NetworkDestination, type MacosExecutionBinding, type StartProcessRequest } from "@traceforge/execution-node";
import type { ScenarioAuthorizationPort } from "@traceforge/scenario-sdk";
import type { McpConnection } from "@traceforge/shared/desktop-mcp";
import { ConversationWorkspaces } from "./conversation-workspaces.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const connectionReceipt = ({ canonicalUrl: _url, ...connection }: NetworkDestination) => connection;

export function readWorkspaceNetworkReceipts(sqlite: Database.Database, owner: { caseId: string; runId: string; idempotencyKey: string }) {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_network_receipts'").get()) return [];
  return (sqlite.prepare("SELECT id,kind,destination,status,detail_json,created_at,ended_at FROM workspace_network_receipts WHERE parent_key=? AND case_id=? AND run_id=? ORDER BY created_at,id LIMIT 128")
    .all(owner.idempotencyKey, owner.caseId, owner.runId) as Array<{ id: string; kind: string; destination: string; status: string; detail_json: string; created_at: string; ended_at: string | null }>)
    .map(row => ({ id: row.id, kind: row.kind, destinationOrigin: row.destination, status: row.status === "pending" ? "unknown" : row.status,
      detail: JSON.parse(row.detail_json), createdAt: row.created_at, endedAt: row.ended_at }));
}

/** Local composition adapter. Networking is tied to the exact running tool, not
 * merely a live Run. HTTPS receipts describe a connection, never decrypted HTTP. */
export class WorkspaceNetworkHost {
  private readonly workspaces: ConversationWorkspaces;
  constructor(private readonly sqlite: Database.Database, private readonly authorization: ScenarioAuthorizationPort, private readonly projectRoot: string) {
    this.workspaces = new ConversationWorkspaces(sqlite,projectRoot);
    sqlite.exec(`CREATE TABLE IF NOT EXISTS workspace_network_receipts (
      id TEXT PRIMARY KEY, parent_key TEXT NOT NULL, case_id TEXT NOT NULL, run_id TEXT NOT NULL,
      kind TEXT NOT NULL, destination TEXT NOT NULL, request_digest TEXT NOT NULL,
      status TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT
    ); CREATE INDEX IF NOT EXISTS workspace_network_parent ON workspace_network_receipts(parent_key);`);
    // A new local execution service cannot adopt old sockets or replay requests.
    sqlite.prepare("UPDATE workspace_network_receipts SET status='unknown',ended_at=? WHERE status='pending'").run(new Date().toISOString());
    sqlite.exec(`CREATE TABLE IF NOT EXISTS desktop_mcp_network_receipts (
      id TEXT PRIMARY KEY, parent_key TEXT NOT NULL, case_id TEXT NOT NULL, run_id TEXT NOT NULL,
      connection_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL,
      destination TEXT NOT NULL, status TEXT NOT NULL, detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL, ended_at TEXT
    ); CREATE INDEX IF NOT EXISTS desktop_mcp_network_parent ON desktop_mcp_network_receipts(parent_key);`);
    if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_physical_policy'").get())
      sqlite.exec(`CREATE TRIGGER IF NOT EXISTS desktop_mcp_network_admit BEFORE INSERT ON desktop_mcp_network_receipts BEGIN
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,8192,'execution')
        FROM execution_physical_policy WHERE id=1; END;`);
    sqlite.prepare("UPDATE desktop_mcp_network_receipts SET status='unknown',ended_at=? WHERE status='pending'").run(new Date().toISOString());
  }
  async bind(request: Readonly<StartProcessRequest>): Promise<MacosExecutionBinding | undefined> {
    if (request.attribution.actionId.startsWith("desktop.mcp:")) return this.bindMcp(request);
    if (request.permissions.network !== "brokered") return undefined;
    const owner = request.attribution;
    const root = this.workspaces.root(owner.caseId,owner.runId);
    if (request.workingDirectory !== root || request.executable !== "/bin/bash") throw new Error("Brokered workspace execution requires its exact owned directory and supported launcher");
    const current = () => {
      const now = new Date().toISOString();
      if (!Number.isFinite(Date.parse(owner.leaseExpiresAt)) || Date.parse(owner.leaseExpiresAt) <= Date.now()) throw new Error("Workspace network lease expired");
      const row = this.sqlite.prepare(`SELECT b.tool_name,e.status FROM scenario_work_leases l JOIN scenario_event_streams r ON r.run_id=l.run_id
        JOIN tool_invocation_bindings b ON b.run_id=l.run_id AND b.work_id=l.work_id JOIN tool_invocation_executions e USING(idempotency_key)
        WHERE l.run_id=? AND l.work_id=? AND l.lease_id=? AND l.worker_id=? AND r.case_id=? AND r.status='running'
        AND l.lease_expires_at>? AND b.idempotency_key=? AND b.tool_name IN ('workspace_execute','workspace_start') AND b.tool_source='traceforge.builtin'
        AND e.lease_id=l.lease_id`)
        .get(owner.runId, owner.workId, owner.leaseId, owner.workerId, owner.caseId, now, owner.idempotencyKey) as { tool_name: string; status: string } | undefined;
      if (!row) throw new Error("Workspace network invocation is no longer current");
      if (row.tool_name === "workspace_execute" && row.status !== "executing") throw new Error("Workspace network invocation is no longer current");
      if (row.tool_name === "workspace_start") {
        const boundOwner = JSON.stringify([owner.caseId, owner.runId, owner.workId, owner.scopeRef, owner.workerId, owner.leaseId]);
        if (!this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_jobs'").get()
          || !this.sqlite.prepare("SELECT 1 FROM workspace_jobs WHERE invocation=? AND owner=? AND state IN ('starting','running')").get(owner.idempotencyKey, boundOwner)) throw new Error("Asynchronous workspace execution is no longer current");
      }
      const scope = this.sqlite.prepare("SELECT 1 FROM scenario_events WHERE run_id=? AND event_type='run_started' AND json_extract(payload_json,'$.state.scopeRef')=? LIMIT 1").get(owner.runId, owner.scopeRef);
      if (!scope) throw new Error("Workspace network scope does not belong to the Run");
      this.authorization.requireAction(owner.scopeRef, owner.caseId, "workspace.execute");
      this.authorization.requireAction(owner.scopeRef, owner.caseId, "workspace.network");
    };
    const authorize = (url: URL, signal: AbortSignal) => resolveNetworkDestination(url.href, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), authorize: target => {
        current();
        const grant = this.authorization.authorizeResource(owner.scopeRef, owner.caseId, "workspace.network", "workspace.network", target);
        return { authorizationRef: grant.id, canonicalUrl: grant.canonicalValue, expiresAt: grant.expiresAt };
      },
    });
    const begin = (id: string, kind: string, url: URL, input: unknown) => {
      current();
      // No request credentials/body/token in audit storage; target path is hashed.
      this.sqlite.prepare("INSERT INTO workspace_network_receipts VALUES (?,?,?,?,?,?,?,'pending','{}',?,NULL)")
        .run(id, owner.idempotencyKey, owner.caseId, owner.runId, kind, url.origin, hash(input), new Date().toISOString());
    };
    const end = (id: string, status: string, detail: unknown) => {
      this.sqlite.prepare("UPDATE workspace_network_receipts SET status=?,detail_json=?,ended_at=? WHERE id=? AND status='pending'")
        .run(status, JSON.stringify(detail), new Date().toISOString(), id);
    };
    current();
    const endpoint = await openProcessNetworkEndpoint({ assertCurrent: current,
      http: async (input, signal) => {
        const url = new URL(input.url), address = await authorize(url, signal);
        signal.throwIfAborted(); begin(input.id, "http", url, input);
        try {
          const result = await requestPinnedHttp(address, { ...input, maximumBytes: 16 * 1024 * 1024,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
          if (result.bodyTruncated) throw new Error("Response capacity exceeded");
          current(); signal.throwIfAborted();
          end(input.id, "completed", { destination: connectionReceipt(address), status: result.status, bytes: result.body.length, bodyDigest: hash(result.body), redirectFollowed: false });
          return { ...result, headers: Object.fromEntries(Object.entries(result.headers).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)) };
        } catch (error) { end(input.id, "unknown", {}); throw error; }
      },
      websocket: async (input, signal) => {
        if ((this.authorization.requireAction(owner.scopeRef, owner.caseId, "workspace.network").scopePayload as Record<string,unknown>)?.workspaceWebSocket !== true) throw new Error("WebSocket connections require explicit consent");
        const url = new URL(input.url), address = await authorize(url, signal);
        signal.throwIfAborted(); begin(input.id, "websocket_connection", url, input);
        try {
          const upgraded = await upgradePinnedWebSocket(address, input.headers, signal);
          const socket = upgraded.stream;
          const stop = () => socket.destroy(); signal.addEventListener('abort',stop,{once:true});
          socket.on('error',()=>undefined);
          socket.once('close',()=>{signal.removeEventListener('abort',stop);end(input.id,'closed',{destination:connectionReceipt(address),incoming:socket.bytesRead,outgoing:socket.bytesWritten,applicationOutcome:'not_observable'});});
          try { current(); signal.throwIfAborted(); } catch(error) { socket.destroy(); throw error; }
          return {stream:socket,headers:Object.fromEntries(Object.entries(upgraded.headers).filter((entry):entry is [string,string|string[]]=>entry[1]!==undefined))};
        } catch(error) {end(input.id,'unknown',{});throw error;}
      },
      tunnel: async (input, signal) => {
        const url = new URL(`https://${input.hostname.includes(":") && !input.hostname.startsWith("[") ? `[${input.hostname}]` : input.hostname}:${input.port}/`), address = await authorize(url, signal);
        signal.throwIfAborted(); begin(input.id, "opaque_connection", url, input);
        let socket: Awaited<ReturnType<typeof connectPinnedTcp>> | undefined;
        try {
          socket = await connectPinnedTcp(address, signal);
          const owned = socket;
          socket.once("close", () => end(input.id, "closed", { destination: connectionReceipt(address), incoming: owned.bytesRead, outgoing: owned.bytesWritten,
            transport: input.transport ?? "connect", applicationOutcome: "not_observable" }));
          current(); signal.throwIfAborted(); return socket;
        } catch (error) { socket?.destroy(); end(input.id, "unknown", {}); throw error; }
      },
    }, { signal: new AbortController().signal, maximumRequests: 128, maximumBytes: 16 * 1024 * 1024, timeoutMs: Math.min(request.timeoutMs, 3600000) });
    return { brokerPort: endpoint.port, signal: endpoint.signal, assertCurrent: current, release: endpoint.close,
      environment: { HTTP_PROXY: endpoint.proxyUrl, HTTPS_PROXY: endpoint.proxyUrl, http_proxy: endpoint.proxyUrl, https_proxy: endpoint.proxyUrl,
        ALL_PROXY: endpoint.socksUrl, all_proxy: endpoint.socksUrl, WS_PROXY: endpoint.proxyUrl, WSS_PROXY: endpoint.proxyUrl, NO_PROXY: "", no_proxy: "" } };
  }
  private async bindMcp(request: Readonly<StartProcessRequest>): Promise<MacosExecutionBinding> {
    const owner = request.attribution;
    const match = /^desktop\.mcp:([a-z][a-z0-9_-]{0,63}):([1-9][0-9]*)$/.exec(owner.actionId);
    if (!match) throw new Error("MCP network execution identity is invalid");
    const id = match[1]!, revision = Number(match[2]);
    const row = this.sqlite.prepare("SELECT value_json FROM desktop_mcp_versions WHERE id=? AND revision=?")
      .get(id,revision) as {value_json:string}|undefined;
    const version = row && JSON.parse(row.value_json) as {connection:McpConnection;credentialRef?:string};
    const connection = version?.connection;
    if (!connection || connection.transport!=="stdio"
      || request.executable!==realpathSync(connection.executable!) || request.workingDirectory!==realpathSync(connection.workingDirectory!)
      || JSON.stringify(request.arguments)!==JSON.stringify(connection.arguments??[])) throw new Error("MCP network process is outside its reviewed connection");
    const hasNetwork=!!connection.networkOrigins?.length;
    if(request.permissions.network !== (hasNetwork?"brokered":"deny"))throw new Error("MCP network permission differs from its reviewed connection");
    const secretName=connection.secretEnvironmentVariable;
    const secret=request.environment;
    if(Object.keys(secret).length !== (version?.credentialRef?1:0)
      || (version?.credentialRef && (!secretName || typeof secret[secretName]!=="string" || !secret[secretName]
        || Buffer.byteLength(secret[secretName])>65535 || secret[secretName].includes("\0") || request.permissions.secrets!=="plaintext"))
      || (!version?.credentialRef && request.permissions.secrets!=="deny")) throw new Error("MCP credential does not match its reviewed connection");
    const current = () => {
      if (!(Date.parse(owner.leaseExpiresAt)>Date.now())) throw new Error("MCP network lease expired");
      if (this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='process_execution_occupancy'").get()) {
        const occupied=this.sqlite.prepare("SELECT identity_json,state FROM process_execution_occupancy WHERE process_key=?").get(owner.idempotencyKey) as {identity_json:string;state:string}|undefined;
        const identity=occupied&&JSON.parse(occupied.identity_json) as {source?:string;operation?:string;parentInvocationKey?:string};
        if (!occupied || occupied.state!=="dispatched" || identity?.source!==`desktop.mcp.${id}` ||
          identity.operation!==(owner.runId==="desktop-mcp"?"mcp.discovery":"mcp.call")) throw new Error("MCP network process occupancy is not current");
        if (owner.runId!=="desktop-mcp" && !this.sqlite.prepare(`SELECT 1 FROM tool_invocation_bindings b JOIN tool_invocation_executions e USING(idempotency_key)
          WHERE b.idempotency_key=? AND b.run_id=? AND b.work_id=? AND b.tool_source=? AND e.status='executing'`)
          .get(identity.parentInvocationKey,owner.runId,owner.workId,`desktop.mcp.${id}.r${revision}`)) throw new Error("MCP network invocation is not current");
      }
      const head = this.sqlite.prepare("SELECT revision,active,deleted FROM desktop_mcp_heads WHERE id=?").get(id) as {revision:number;active:number|null;deleted:number}|undefined;
      if (!head || head.deleted) throw new Error("MCP network connection was revoked");
      if (owner.runId==="desktop-mcp") {
        if (owner.caseId!=="desktop-mcp" || owner.scopeRef!==id || owner.workId!=="discovery" || head.revision!==revision) throw new Error("MCP discovery no longer owns this connection");
      } else {
        if (head.active===null || !this.sqlite.prepare("SELECT 1 FROM desktop_mcp_runs WHERE run_id=? AND id=? AND revision=?").get(owner.runId,id,revision)) throw new Error("MCP revision is not enabled for this Run");
        const lease = this.sqlite.prepare(`SELECT 1 FROM scenario_work_leases l JOIN scenario_event_streams r ON r.run_id=l.run_id
          WHERE l.run_id=? AND l.work_id=? AND l.lease_id=? AND l.worker_id=? AND r.case_id=? AND r.status='running' AND l.lease_expires_at>?`)
          .get(owner.runId,owner.workId,owner.leaseId,owner.workerId,owner.caseId,new Date().toISOString());
        if (!lease) throw new Error("MCP network Work is no longer current");
        this.authorization.requireAction(owner.scopeRef,owner.caseId,connection.authorizationAction);
      }
    };
    const authorize = async (url: URL,signal:AbortSignal) => {
      current();
      const allowed = connection.networkOrigins!.includes(`${url.origin}/`) ||
        (connection.destinationAddresses??[]).includes(url.hostname.replace(/^\[|\]$/g,"")) && connection.networkOrigins!.some(origin => {
          const reviewed=new URL(origin); return reviewed.protocol===url.protocol && reviewed.port===url.port;
        });
      if (!allowed) throw new Error("MCP network destination is outside the reviewed origins");
      return resolveNetworkDestination(url.href,{signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)]),
        allowedAddresses:connection.destinationAddresses,
        authorize: target => {current();return {canonicalUrl:target,authorizationRef:`desktop-mcp:${id}:${revision}`,expiresAt:owner.leaseExpiresAt};}});
    };
    const begin=(key:string,kind:string,url:URL)=>{current();this.sqlite.prepare("INSERT INTO desktop_mcp_network_receipts VALUES (?,?,?,?,?,?,?,?,?,'{}',?,NULL)")
      .run(key,owner.idempotencyKey,owner.caseId,owner.runId,id,revision,kind,url.origin,"pending",new Date().toISOString());};
    const end=(key:string,status:string,detail:unknown)=>this.sqlite.prepare("UPDATE desktop_mcp_network_receipts SET status=?,detail_json=?,ended_at=? WHERE id=? AND status='pending'")
      .run(status,JSON.stringify(detail),new Date().toISOString(),key);
    current();
    if(!hasNetwork)return {signal:new AbortController().signal,assertCurrent:current,release:async()=>{},
      ...(version?.credentialRef?{secretEnvironment:{[secretName!]:secret[secretName!]!}}:{})};
    const endpoint=await openProcessNetworkEndpoint({assertCurrent:current,
      http:async(input,signal)=>{
        const url=new URL(input.url),destination=await authorize(url,signal);begin(input.id,"http",url);
        try {const result=await requestPinnedHttp(destination,{...input,maximumBytes:64*1024*1024,signal});
          if(result.bodyTruncated)throw new Error("MCP network response exceeded transfer limit");
          current();end(input.id,"completed",{destination:connectionReceipt(destination),status:result.status,bytes:result.body.length,bodyDigest:hash(result.body)});
          return {...result,headers:Object.fromEntries(Object.entries(result.headers).filter((entry):entry is [string,string|string[]]=>entry[1]!==undefined))};
        }catch(error){end(input.id,"unknown",{});throw error;}
      },
      tunnel:async(input,signal)=>{
        const url=new URL(`https://${input.hostname.includes(":")&&!input.hostname.startsWith("[")?`[${input.hostname}]`:input.hostname}:${input.port}/`);
        const destination=await authorize(url,signal);begin(input.id,"opaque_connection",url);
        try {const socket=await connectPinnedTcp(destination,signal);
          socket.once("close",()=>end(input.id,"closed",{destination:connectionReceipt(destination),incoming:socket.bytesRead,outgoing:socket.bytesWritten,applicationOutcome:"not_observable"}));
          current();return socket;
        }catch(error){end(input.id,"unknown",{});throw error;}
      },
    },{signal:new AbortController().signal,maximumRequests:Number.MAX_SAFE_INTEGER,maximumBytes:64*1024*1024,
      maximumStreamBytes:Number.MAX_SAFE_INTEGER,timeoutMs:Math.min(request.timeoutMs,2147483647)});
    return {brokerPort:endpoint.port,signal:endpoint.signal,assertCurrent:current,release:endpoint.close,
      ...(version?.credentialRef?{secretEnvironment:{[secretName!]:secret[secretName!]!}}:{}),
      environment:{HTTP_PROXY:endpoint.proxyUrl,HTTPS_PROXY:endpoint.proxyUrl,http_proxy:endpoint.proxyUrl,https_proxy:endpoint.proxyUrl,
        ALL_PROXY:endpoint.socksUrl,all_proxy:endpoint.socksUrl,NO_PROXY:"",no_proxy:""}};
  }
}
