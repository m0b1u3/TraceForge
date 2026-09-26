import { randomUUID } from "node:crypto";
import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { ExecutionNodeToolProviderClient, type ToolExecutionContext } from "@traceforge/worker-runtime";
import type { ExecutionAttribution, ExecutionNode } from "@traceforge/execution-node";
import type { McpCatalog, McpConnection } from "@traceforge/shared/desktop-mcp";
import type { ProcessExecutionCapacity, ProcessCapacityLease } from "./process-execution-capacity.js";
import { mcpDigest } from "./desktop-mcp-session.js";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";

/** Stdio uses the existing sandboxed client and host-wide capacity. Network access is host-brokered. */
export class DesktopMcpStdioSession {
  readonly receipts: string[]=[];
  private catalog?: McpCatalog;
  private client?:ExecutionNodeToolProviderClient;
  private admission?:ProcessCapacityLease;
  private processKey?:string;
  constructor(private readonly connection:McpConnection,private readonly node:ExecutionNode,private readonly capacity:ProcessExecutionCapacity,
    private readonly attribution:ExecutionAttribution,private readonly check:()=>void,private readonly signal?:AbortSignal,private readonly credential?:string,private readonly sqlite?:Database.Database){}
  private get permissions():EffectivePermissionProfile {const c=this.connection;return {version:1,platform:"darwin",filesystem:{read:[{path:c.executable!,scope:"exact"},{path:c.workingDirectory!,scope:"tree"},...(c.networkOrigins?.length?[{path:"/usr/bin/env",scope:"exact" as const}]:[]),...(c.readPaths??[]).map(path=>({path,scope:"tree" as const}))],write:(c.writePaths??[]).map(path=>({path,scope:"tree" as const})),deny:[]},network:c.networkOrigins?.length?"brokered":"deny",process:{access:"sandboxed",interactive:false,background:false},secrets:this.credential?"plaintext":"deny",sources:["desktop-mcp-operator-grant"]};}
  private async open(inspection:boolean) {
    this.check();this.signal?.throwIfAborted();
    const c=this.connection,attribution={...this.attribution,idempotencyKey:`${this.attribution.idempotencyKey}:${randomUUID()}`};
    this.processKey=attribution.idempotencyKey;
    const work=this.attribution.runId!=="desktop-mcp";
    this.admission=await this.capacity.acquire({source:`desktop.mcp.${c.id}`,version:mcpDigest(c).slice(7),operation:inspection?"mcp.discovery":"mcp.call",kind:work?"work":"service",attribution,...(work?{parentInvocationKey:this.attribution.idempotencyKey}:{})},this.signal,this.check);
    const requestTimeoutMs=c.requestTimeoutMs??60_000,processTimeoutMs=c.processTimeoutMs??Math.min(2147483647,Math.max(600_000,requestTimeoutMs+30_000));
    try{
    let volume=c.workingDirectory!;
    while(!existsSync(volume)&&volume!==dirname(volume))volume=dirname(volume);
    const fs=statfsSync(volume,{bigint:true});
    const writeBytes=Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,Number(fs.bavail*fs.bsize)-64*1024*1024));
    if (writeBytes===0) throw new Error("Insufficient free space for MCP process");
    this.client=new ExecutionNodeToolProviderClient({node:this.node,executable:c.executable!,arguments:c.arguments??[],workingDirectory:c.workingDirectory!,environment:this.credential?{[c.secretEnvironmentVariable!]:this.credential}:{},attribution,
      operatorGrantedPlaintextSecret:!!this.credential,
      permissions:this.permissions,
      resources:{cpuTimeMs:processTimeoutMs,memoryBytes:2*1024*1024*1024,maximumProcesses:64,writeBytes},beforeProcessStart:this.admission?.beforeStart,
      requestTimeoutMs,processTimeoutMs,outputLimitBytes:16*1024*1024,maximumFrameBytes:16*1024*1024,
      mcp:inspection?{inspection:true,serverName:"inspection",serverVersion:"1",tools:[]}:{serverName:this.catalog!.serverName,serverVersion:this.catalog!.serverVersion,tools:this.catalog!.tools.map((t,index)=>({remoteName:t.name,tool:{name:`mcp.${index}`,source:`desktop.mcp.${c.id}`,version:this.catalog!.digest,priority:0,description:"Reviewed MCP tool",inputSchema:t.inputSchema,providedCapabilities:[c.capability],dependencyCapabilities:[],permissionRequirements:{},risk:"privileged",timeoutMs:requestTimeoutMs}}))},
    });return this.client;}catch(error){this.admission?.finish(false);this.admission=undefined;throw error;}
  }
  async close(){const client=this.client,admission=this.admission,key=this.processKey;this.client=undefined;this.admission=undefined;this.processKey=undefined;if(!client)return;let terminal=false;try{await client.close();terminal=true;}finally{admission?.finish(terminal);
    if(key&&this.sqlite?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_mcp_network_receipts'").get())
      this.receipts.push(...(this.sqlite.prepare("SELECT id FROM desktop_mcp_network_receipts WHERE parent_key=? ORDER BY created_at,id").all(key) as Array<{id:string}>).map(row=>row.id));}}
  async discover(){const client=await this.open(true);try{const data=await client.inspectMcpCatalog(this.signal);this.check();
    if(this.credential&&JSON.stringify(data).includes(this.credential))throw new Error("MCP catalog contains its configured credential");
    this.catalog={...data,digest:mcpDigest(data)};return this.catalog;}catch(error){await this.close();throw error;}}
  async rpc(method:string,params:{name:string;arguments:unknown}) {
    if(method!=="tools/call"||!this.catalog)throw new Error("MCP stdio session is not reviewed");
    const index=this.catalog.tools.findIndex(t=>t.name===params.name);if(index<0)throw new Error("Unknown MCP tool");
    const client=this.client;if(!client)throw new Error("MCP inspection session closed");
    client.bindInspectedMcpTools(this.catalog.tools.map((t,index)=>({remoteName:t.name,tool:{name:`mcp.${index}`,source:`desktop.mcp.${this.connection.id}`,version:this.catalog!.digest,priority:0,description:"Reviewed MCP tool",inputSchema:t.inputSchema,providedCapabilities:[this.connection.capability],dependencyCapabilities:[],permissionRequirements:{},risk:"privileged",timeoutMs:this.connection.requestTimeoutMs??60_000}})));
    try{this.check();this.signal?.throwIfAborted();
      const result=await client.callTool(`mcp.${index}`,params.arguments,{...this.attribution,signal:this.signal,effectivePermissions:this.permissions});
      this.check();return {content:[{type:"text",text:this.credential?result.raw.split(this.credential).join("[redacted]"):result.raw}],isError:result.status!=="succeeded"};
    }finally{await this.close();}
  }
}
