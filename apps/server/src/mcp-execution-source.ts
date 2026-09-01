import type Database from "better-sqlite3";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { randomUUID } from "node:crypto";
import type { ExecutionNode } from "@traceforge/execution-node";
import type { ScenarioRunState } from "@traceforge/orchestration-core";
import type { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { ExecutionNodeToolProviderClient, type ExecutionNodeToolProviderOptions, type ExecutionToolAdapter,
  type ExecutionToolDiscoverySource, type McpToolPolicy, type ToolExecutionContext, toolInvocationInputFingerprint } from "@traceforge/worker-runtime";
import type { ProcessExecutionCapacity, ProcessCapacityLease } from "./process-execution-capacity.js";

export interface FoundationMcpServer {
  source: string;
  serverName: string;
  serverVersion: string;
  process: Omit<ExecutionNodeToolProviderOptions, "node" | "mcp" | "capabilityHost" | "expectedProviderId" | "expectedProviderVersion" | "beforeProcessStart">;
  tools: Array<McpToolPolicy & {
    authorizationAction: string;
    validateInput(input: unknown): void;
    /** Trusted adapter must enforce target/resource restrictions; schema validity alone is not authorization. */
    authorizeInput(scopePayload: unknown, input: unknown): void;
  }>;
}

/** Each discovery/call has its own isolated process. No cross-Run session or raw stdio fallback. */
export function createFoundationMcpSource(config: FoundationMcpServer, node: ExecutionNode | undefined,
  sqlite: Database.Database, packages: ScenarioPackageRegistry, loadRun: (id: string) => ScenarioRunState | null,
  capacity?: ProcessExecutionCapacity): ExecutionToolDiscoverySource {
  if (!node) throw new Error("MCP requires a controlled Execution Node");
  if (config.tools.some((p) => p.tool.source !== config.source || !p.authorizationAction.trim()
    || typeof p.validateInput !== "function" || typeof p.authorizeInput !== "function")) throw new Error("Invalid MCP host policy");
  const { diagnosticWriter, ...serializableProcess } = config.process;
  const processOptions = { ...structuredClone(serializableProcess), diagnosticWriter };
  const tools = config.tools.map((p) => ({ ...p, tool: { ...structuredClone(p.tool), version: `${p.tool.version}+mcp.${toolInvocationInputFingerprint("mcp.binding", {
    serverName: config.serverName, serverVersion: config.serverVersion, remoteName: p.remoteName,
    authorizationAction: p.authorizationAction, process: serializableProcess,
  })}` } }));
  const protocol = { serverName: config.serverName, serverVersion: config.serverVersion,
    tools: tools.map(({ remoteName, tool }) => ({ remoteName, tool })) };
  const active = new Map<ExecutionNodeToolProviderClient,ProcessCapacityLease|undefined>(); let closed = false;
  const closing=new AbortController();
  const capacityVersion=toolInvocationInputFingerprint("mcp.process",{source:config.source,serverName:config.serverName,serverVersion:config.serverVersion,process:serializableProcess});
  const client = async (attribution = processOptions.attribution,operation="mcp.discovery",context?:ToolExecutionContext,signal?:AbortSignal,authorize?:()=>void) => {
    if (closed) throw new Error("MCP source is closed");
    const owned={...attribution,idempotencyKey:`${attribution.idempotencyKey}:mcp-session:${randomUUID()}`};
    const admission=await capacity?.acquire({source:config.source,version:capacityVersion,operation,kind:context?"work":"service",attribution:owned,
      ...(context?{parentInvocationKey:context.idempotencyKey}:{})},AbortSignal.any([closing.signal,...(signal?[signal]:[])]),authorize);
    try{
    const instance = new ExecutionNodeToolProviderClient({ ...processOptions, node,
      attribution: owned,beforeProcessStart:admission?.beforeStart,
      mcp: protocol, expectedProviderId: config.serverName, expectedProviderVersion: config.serverVersion });
    active.set(instance,admission); return instance;
    }catch(error){admission?.finish(false);throw error;}
  };
  const finish = async (instance: ExecutionNodeToolProviderClient) => { let terminal=false;const admission=active.get(instance);
    try { await instance.close();terminal=true; } finally {try{admission?.finish(terminal);}finally{active.delete(instance);}} };
  return {
    source: config.source,
    async discover(signal?: AbortSignal): Promise<ExecutionToolAdapter[]> {
      const discovery = await client(undefined,"mcp.discovery",undefined,signal);
      let specs;
      try { specs = await discovery.listTools(signal); } finally { await finish(discovery); }
      return specs.map((tool) => ({ ...tool, execute: async (input, context) => {
        const policy = tools.find((p) => p.tool.name === tool.name)!;
        const authorize = () => {
          policy.validateInput(input);
          const run = loadRun(context.runId); const work = run?.workItems.find((w) => w.id === context.workId);
          if (!run?.scenarioPackage || run.status !== "running" || run.caseId !== context.caseId || run.scopeRef !== context.scopeRef
            || !work || work.status !== "running" || work.workerId !== context.workerId || work.leaseId !== context.leaseId
            || !work.leaseExpiresAt || !(Date.parse(work.leaseExpiresAt) > Date.now()) || context.signal?.aborted) throw new Error("Inactive MCP Work");
          const {scope,package:pkg} = new SqliteScenarioAuthorizationService(sqlite,packages).requireRun(run);
          if (!scope.allowedActions.includes(policy.authorizationAction) || scope.deniedActions.includes(policy.authorizationAction)
            || pkg.authorizationPolicy.authorizeResource?.(scope.payload, "mcp.tool", policy.remoteName) !== policy.remoteName) throw new Error("MCP action not authorized");
          policy.authorizeInput(scope.payload, input);
        };
        try { authorize(); }
        catch { return { status: "failed", summary: "MCP request rejected by host input or authorization policy", raw: "", refs: [], retryable: false }; }
        const invocation = await client({ caseId: context.caseId, runId: context.runId, workId: context.workId, workerId: context.workerId,
          scopeRef: context.scopeRef, leaseId: context.leaseId, leaseExpiresAt: context.leaseExpiresAt,
          idempotencyKey: context.idempotencyKey, actionId: policy.authorizationAction },tool.name,context,context.signal,authorize);
        const abort = () => { void invocation.close().catch(() => undefined); }; // finish() reports unconfirmed cleanup to Gateway
        context.signal?.addEventListener("abort", abort, { once: true });
        try {
          // Recheck server/schema for this session. A prior discovery cannot vouch for a replacement process.
          await invocation.listTools(context.signal);
          if (context.signal?.aborted) throw new Error("MCP invocation cancelled before dispatch");
          try { authorize(); }
          catch { return { status: "failed", summary: "MCP authorization changed before dispatch", raw: "", refs: [], retryable: false }; }
          return await invocation.callTool(tool.name, input, context);
        } finally {
          context.signal?.removeEventListener("abort", abort);
          await finish(invocation);
        }
      } }));
    },
    async close() { closed = true;closing.abort(); await Promise.all([...active.keys()].map(finish)); },
  };
}
