import { createHash, randomUUID } from "node:crypto";
import type { ExecutionNode } from "@traceforge/execution-node";
import type { ScenarioPackageResource } from "@traceforge/scenario-sdk";
import type { ProcessExecutionCapacity } from "./process-execution-capacity.js";
import { ExecutionNodeToolProviderClient, toolInvocationInputFingerprint, type ExecutionNodeToolProviderOptions,
  type ToolExecutionContext, type ExecutionToolSpec } from "@traceforge/worker-runtime";

export interface FoundationMcpContextServer {
  source: string;
  serverName: string;
  serverVersion: string;
  /** Bump reviewVersion when host authorization or deployment policy changes. */
  reviewVersion: number;
  process: Omit<ExecutionNodeToolProviderOptions, "node" | "mcp" | "capabilityHost" | "expectedProviderId" | "expectedProviderVersion" | "beforeProcessStart">;
}
export interface PackageContextRemoteLoader {
  profileDigest: `sha256:${string}`;
  read(resource: ScenarioPackageResource, context: ToolExecutionContext, authorize: () => void): Promise<string>;
  close(): Promise<void>;
}
export function mcpContextProfileDigest(config: FoundationMcpContextServer): `sha256:${string}` {
  const { diagnosticWriter: _writer, ...process } = config.process;
  return `sha256:${toolInvocationInputFingerprint("mcp.context.profile", { source: config.source, serverName: config.serverName,
    serverVersion: config.serverVersion, reviewVersion: config.reviewVersion, process })}`;
}

export function createMcpContextLoader(config: FoundationMcpContextServer, node: ExecutionNode | undefined, capacity?:ProcessExecutionCapacity): PackageContextRemoteLoader {
  if (!node) throw new Error("MCP context requires a controlled Execution Node");
  if (!config.source.trim() || !config.serverName.trim() || !config.serverVersion.trim()
    || !Number.isSafeInteger(config.reviewVersion) || config.reviewVersion < 1) throw new Error("Invalid MCP context profile");
  const { diagnosticWriter, ...serializable } = config.process;
  const process = { ...structuredClone(serializable), diagnosticWriter };
  const profileDigest = mcpContextProfileDigest(config);
  const source = config.source, serverName = config.serverName, serverVersion = config.serverVersion;
  const active = new Set<ExecutionNodeToolProviderClient>(); let closed = false;
  const closing=new AbortController();
  return {
    profileDigest,
    async read(resource, context, authorize) {
      const external = resource.context?.external;
      if (closed || !external || external.source !== source || external.profileDigest !== profileDigest) throw new Error("External context profile unavailable");
      authorize(); context.signal?.throwIfAborted();
      const tool: ExecutionToolSpec = { name: "context.remote.read", source, version: profileDigest, priority: 100,
        description: "Host-pinned external text", inputSchema: { type: "object", additionalProperties: false },
        providedCapabilities: [], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 2000 };
      const attribution={ caseId: context.caseId, runId: context.runId, workId: context.workId, workerId: context.workerId,
          scopeRef: context.scopeRef, leaseId: context.leaseId, leaseExpiresAt: context.leaseExpiresAt,
          idempotencyKey: `${context.idempotencyKey}:mcp-context:${randomUUID()}`, actionId: resource.context!.authorizationAction };
      const admission=await capacity?.acquire({source,version:profileDigest,operation:`context.${external.kind}`,kind:"work",attribution,parentInvocationKey:context.idempotencyKey},
        AbortSignal.any([closing.signal,...(context.signal?[context.signal]:[])]),authorize);
      let client:ExecutionNodeToolProviderClient;
      try{client = new ExecutionNodeToolProviderClient({ ...process, node,attribution,beforeProcessStart:admission?.beforeStart,
        mcp: { serverName, serverVersion, catalog: external.kind === "resource" ? "resources" : "prompts",
          tools: [{ remoteName: external.target, arguments: external.arguments, tool }] }, expectedProviderId: serverName, expectedProviderVersion: serverVersion });
      }catch(error){admission?.finish(false);throw error;}
      active.add(client);
      const abort = () => { void client.close().catch(() => undefined); };
      context.signal?.addEventListener("abort", abort, { once: true });
      try {
        await client.listTools(context.signal); authorize(); context.signal?.throwIfAborted();
        const result = await client.callTool(tool.name, {}, context);
        authorize(); context.signal?.throwIfAborted();
        if (result.status !== "succeeded" || `sha256:${createHash("sha256").update(result.raw).digest("hex")}` !== resource.digest) throw new Error("External context content changed");
        return result.raw;
      } finally {
        context.signal?.removeEventListener("abort", abort);
        let terminal=false;try { await client.close();terminal=true; } finally {try{admission?.finish(terminal);}finally{active.delete(client);}}
      }
    },
    async close() { closed = true;closing.abort(); await Promise.all([...active].map((client) => client.close())); },
  };
}
