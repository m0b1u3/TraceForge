import type { BrokeredHttpRequest, BrokeredHttpResponse, StartProcessRequest } from "@traceforge/execution-node";
import type { ExecutionToolDiscoverySource } from "./tool-discovery.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./model.js";

/** Host-created, invocation-scoped operations. Never a raw ExecutionNode or process handle. */
export interface GovernedExecutionPort {
  executeProcess(input: unknown): Promise<ToolExecutionResult>;
  requestHttp(input: Omit<BrokeredHttpRequest, "requestId" | "attribution" | "permissions">): Promise<BrokeredHttpResponse>;
}

export interface ExecutionSourcePolicy {
  version: string;
  process: "denied" | "governed";
  /** Discovery has no Work. A process requires an explicit, trusted host service scope. */
  discoveryService?: {
    attribution: StartProcessRequest["attribution"];
    permissions: ToolExecutionContext["effectivePermissions"];
    /** Synchronous host policy, checked at admission and immediately before dispatch. */
    authorize(): void;
  };
}

/** Factories are reviewed host code, not a sandbox for arbitrary in-process JavaScript. */
export interface GovernedExecutionSourceRegistration extends ExecutionSourcePolicy {
  source: string;
  create(port: GovernedExecutionPort): ExecutionToolDiscoverySource;
}
