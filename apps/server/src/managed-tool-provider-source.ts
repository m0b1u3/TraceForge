import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExecutionNode } from "@traceforge/execution-node";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import {
  ExecutionNodeToolProviderClient,
  type ExecutionToolAdapter,
  type ExecutionToolDiscoverySource,
} from "@traceforge/worker-runtime";
import {
  resolveToolProviderEntrypoint,
  type ToolProviderInstallation,
} from "./tool-provider-control-plane.js";

export function createManagedToolProviderSourceFactory(
  node: ExecutionNode,
  workRootValue: string,
): (installation: ToolProviderInstallation) => ExecutionToolDiscoverySource {
  if (!isAbsolute(workRootValue)) throw new Error("Managed Tool Provider work root must be absolute");
  mkdirSync(workRootValue, { recursive: true, mode: 0o700 });
  const workRoot = realpathSync(workRootValue);
  return (installation) => managedSource(node, workRoot, installation);
}

function managedSource(
  node: ExecutionNode,
  workRoot: string,
  installation: ToolProviderInstallation,
): ExecutionToolDiscoverySource {
  const { manifest } = installation;
  return {
    source: manifest.source,
    async discover() {
      return manifest.tools.map((tool): ExecutionToolAdapter => ({
        ...tool,
        execute: async (input, context) => {
          const scratch = invocationScratch(workRoot, context.runId, context.workId, context.idempotencyKey);
          mkdirSync(scratch, { recursive: true, mode: 0o700 });
          const entrypoint = resolveToolProviderEntrypoint(manifest, installation.packageRoot);
          const permissions = providerPermissions(installation, scratch);
          const client = new ExecutionNodeToolProviderClient({
            node,
            executable: entrypoint.executable,
            arguments: manifest.entrypoint.arguments,
            workingDirectory: entrypoint.workingDirectory,
            environment: {},
            attribution: {
              caseId: context.caseId,
              runId: context.runId,
              workId: context.workId,
              workerId: context.workerId,
              scopeRef: context.scopeRef,
              leaseId: context.leaseId,
              leaseExpiresAt: context.leaseExpiresAt,
              actionId: context.idempotencyKey,
              idempotencyKey: context.idempotencyKey,
            },
            permissions,
            resources: {
              cpuTimeMs: manifest.resources.cpuTimeMs,
              memoryBytes: manifest.resources.memoryBytes,
              maximumProcesses: manifest.resources.maximumProcesses,
              writeBytes: manifest.resources.maximumWriteBytes,
            },
            processTimeoutMs: tool.timeoutMs + 5_000,
            requestTimeoutMs: tool.timeoutMs,
            expectedProviderId: manifest.providerId,
            expectedProviderVersion: manifest.version,
          });
          try {
            return await client.callTool(tool.name, input, context);
          } finally {
            await client.close();
          }
        },
      }));
    },
    diagnostics() {
      return {
        managed: true,
        providerId: manifest.providerId,
        version: manifest.version,
        executionOwnership: "per-invocation",
      };
    },
  };
}

function providerPermissions(
  installation: ToolProviderInstallation,
  scratch: string,
): EffectivePermissionProfile {
  const { manifest, packageRoot } = installation;
  return {
    version: 1,
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
    filesystem: {
      read: [
        { path: packageRoot, scope: "tree" },
        ...(manifest.permissions.filesystem === "scoped_write" ? [{ path: scratch, scope: "tree" } as const] : []),
      ],
      write: manifest.permissions.filesystem === "scoped_write" ? [{ path: scratch, scope: "tree" }] : [],
      deny: [],
    },
    network: manifest.permissions.network,
    process: { access: "sandboxed", interactive: false, background: false },
    secrets: manifest.permissions.secrets === "handles_only" ? "handles_only" : "deny",
    sources: ["tool-provider-manifest", `provider:${manifest.providerId}@${manifest.version}`],
  };
}

function invocationScratch(root: string, runId: string, workId: string, idempotencyKey: string): string {
  const identity = createHash("sha256").update(`${runId}\0${workId}\0${idempotencyKey}`).digest("hex");
  return join(root, identity.slice(0, 2), identity);
}
