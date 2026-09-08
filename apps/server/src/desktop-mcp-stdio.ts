import { randomUUID } from "node:crypto";
import { ExecutionNodeToolProviderClient, type ToolExecutionContext } from "@traceforge/worker-runtime";
import type { ExecutionAttribution, ExecutionNode } from "@traceforge/execution-node";
import type { McpCatalog, McpConnection } from "@traceforge/shared/desktop-mcp";
import type { ProcessExecutionCapacity, ProcessCapacityLease } from "./process-execution-capacity.js";
import { mcpDigest } from "./desktop-mcp-session.js";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";

/** Stdio uses the existing sandboxed client and host-wide capacity. No shell, environment secrets or direct network. */
export class DesktopMcpStdioSession {
  readonly receipts: string[]=[];
  private catalog?: McpCatalog;
  private client?:ExecutionNodeToolProviderClient;
  private admission?:ProcessCapacityLease;
  constructor(private readonly connection:McpConnection,private readonly node:ExecutionNode,private readonly capacity:ProcessExecutionCapacity,
    private readonly attribution:ExecutionAttribution,private readonly check:()=>void,private readonly signal?:AbortSignal){}
  private get permissions():EffectivePermissionProfile {const c=this.connection;return {version:1,platform:"darwin",filesystem:{read:[{path:c.executable!,scope:"exact"},...(c.readPaths??[]).map(path=>({path,scope:"tree" as const}))],write:(c.writePaths??[]).map(path=>({path,scope:"tree" as const})),deny:[]},network:"deny",process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:["desktop-mcp-operator-grant"]};}
  private async open(inspection:boolean) {
    this.check();this.signal?.throwIfAborted();
    const c=this.connection,attribution={...this.attribution,idempotencyKey:`${this.attribution.idempotencyKey}:${randomUUID()}`};
    const work=this.attribution.runId!=="desktop-mcp";
    this.admission=await this.capacity.acquire({source:`desktop.mcp.${c.id}`,version:mcpDigest(c).slice(7),operation:inspection?"mcp.discovery":"mcp.call",kind:work?"work":"service",attribution,...(work?{parentInvocationKey:this.attribution.idempotencyKey}:{})},this.signal,this.check);
    try{this.client=new ExecutionNodeToolProviderClient({node:this.node,executable:c.executable!,arguments:c.arguments??[],workingDirectory:c.workingDirectory!,environment:{},attribution,
      permissions:this.permissions,
      resources:{cpuTimeMs:60000,memoryBytes:256*1024*1024,maximumProcesses:8,writeBytes:32*1024*1024},beforeProcessStart:this.admission?.beforeStart,
      requestTimeoutMs:15000,processTimeoutMs:60000,outputLimitBytes:1024*1024,maximumFrameBytes:262144,
      mcp:inspection?{inspection:true,serverName:"inspection",serverVersion:"1",tools:[]}:{serverName:this.catalog!.serverName,serverVersion:this.catalog!.serverVersion,tools:this.catalog!.tools.map((t,index)=>({remoteName:t.name,tool:{name:`mcp.${index}`,source:`desktop.mcp.${c.id}`,version:this.catalog!.digest,priority:0,description:"Reviewed MCP tool",inputSchema:t.inputSchema,providedCapabilities:[c.capability],dependencyCapabilities:[],permissionRequirements:{},risk:"privileged",timeoutMs:15000}}))},
    });return this.client;}catch(error){this.admission?.finish(false);this.admission=undefined;throw error;}
  }
  async close(){const client=this.client,admission=this.admission;this.client=undefined;this.admission=undefined;if(!client)return;let terminal=false;try{await client.close();terminal=true;}finally{admission?.finish(terminal);}}
  async discover(){const client=await this.open(true);try{const data=await client.inspectMcpCatalog(this.signal);this.check();this.catalog={...data,digest:mcpDigest(data)};return this.catalog;}catch(error){await this.close();throw error;}}
  async rpc(method:string,params:{name:string;arguments:unknown}) {
    if(method!=="tools/call"||!this.catalog)throw new Error("MCP stdio session is not reviewed");
    const index=this.catalog.tools.findIndex(t=>t.name===params.name);if(index<0)throw new Error("Unknown MCP tool");
    const client=this.client;if(!client)throw new Error("MCP inspection session closed");
    client.bindInspectedMcpTools(this.catalog.tools.map((t,index)=>({remoteName:t.name,tool:{name:`mcp.${index}`,source:`desktop.mcp.${this.connection.id}`,version:this.catalog!.digest,priority:0,description:"Reviewed MCP tool",inputSchema:t.inputSchema,providedCapabilities:[this.connection.capability],dependencyCapabilities:[],permissionRequirements:{},risk:"privileged",timeoutMs:15000}})));
    try{this.check();this.signal?.throwIfAborted();
      const result=await client.callTool(`mcp.${index}`,params.arguments,{...this.attribution,signal:this.signal,effectivePermissions:this.permissions});
      this.check();return {content:[{type:"text",text:result.raw}],isError:result.status!=="succeeded"};
    }finally{await this.close();}
  }
}
