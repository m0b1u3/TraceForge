import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  BrokeredHttpGateway,
  EXECUTION_PROTOCOL_VERSION,
  ExecutionNodeRpcClient,
  ExecutionNodeRpcServer,
  ExecutionRpcDispatcher,
  LocalExecutionNode,
  NativeTerminalProcessLauncher,
  NodeSpawnProcessLauncher,
  WindowsConptyProcessLauncher,
  compileLinuxStdioSandboxLaunch,
  compileLinuxPtySandboxLaunch,
  compileWindowsConptySandboxLaunch,
  compileWindowsStdioSandboxLaunch,
  createExecutionRpcAuthToken,
  defaultExecutionRpcPipe,
  type ExecutionNode,
  type ProcessLauncher,
  type ProcessLaunchIdentity,
  type StartProcessRequest,
} from "@traceforge/execution-node";
import type { ScenarioAuthorizationPort } from "@traceforge/scenario-sdk";
import type Database from "better-sqlite3";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import {
  SqliteProcessOperationJournal,
  type ProcessOperationJournalUsage,
} from "./execution-process-operation-journal.js";
import { preflightLocalExecutionNode, refreshLocalExecutionNodeHealth, type LinuxSandboxRuntime, type LocalExecutionNodeHealth } from "./local-execution-node-lifecycle.js";

export interface LocalExecutionNodeService {
  client: ExecutionNode;
  readonly processReady: boolean;
  health(): Promise<LocalExecutionNodeServiceHealth>;
  close(): Promise<void>;
}

export interface LocalExecutionNodeServiceHealth extends LocalExecutionNodeHealth {
  operationJournal: {
    state: "ready" | "capacity_exhausted";
    records: number;
    activeRecords: number;
    archivedRecords: number;
    uncertainRecords: number;
    reservedBytes: number;
    maximumRecords: number;
    maximumActiveRecords: number;
    maximumBytes: number;
  };
}

export function processOperationJournalHealth(usage: ProcessOperationJournalUsage): LocalExecutionNodeServiceHealth["operationJournal"] {
  const exhausted = usage.records >= usage.limits.maximumRecords
    || usage.activeRecords >= usage.limits.maximumActiveRecords
    || usage.reservedBytes + usage.limits.maximumRecordBytes > usage.limits.maximumBytes;
  return {
    state: exhausted ? "capacity_exhausted" : "ready",
    records: usage.records,
    activeRecords: usage.activeRecords,
    archivedRecords: usage.archivedRecords,
    uncertainRecords: usage.uncertainRecords,
    reservedBytes: usage.reservedBytes,
    maximumRecords: usage.limits.maximumRecords,
    maximumActiveRecords: usage.limits.maximumActiveRecords,
    maximumBytes: usage.limits.maximumBytes,
  };
}

class PlatformSandboxLauncher implements ProcessLauncher {
  private readonly stdio: NodeSpawnProcessLauncher;
  private readonly terminal: NativeTerminalProcessLauncher | WindowsConptyProcessLauncher;

  constructor(
    backendExecutable: string,
    backendMeasurement: string,
    linuxRuntime?: LinuxSandboxRuntime,
  ) {
    if (process.platform === "win32") {
      const options = { windowsHelperPath: backendExecutable, backendMeasurement, pathExists: existsSync };
      const assertMeasurement = () => {
        const currentMeasurement = createHash("sha256").update(readFileSync(backendExecutable)).digest("hex");
        if (currentMeasurement !== backendMeasurement) {
          throw new Error("TraceForge Windows sandbox helper changed after startup; execution denied");
        }
      };
      this.stdio = new NodeSpawnProcessLauncher((request) => {
        assertMeasurement();
        return compileWindowsStdioSandboxLaunch(request, options);
      });
      this.terminal = new WindowsConptyProcessLauncher((request) => {
        assertMeasurement();
        return compileWindowsConptySandboxLaunch(request, options);
      });
      return;
    }
    if (!linuxRuntime) throw new Error("TraceForge Linux sandbox runtime is unavailable");
    this.stdio = new NodeSpawnProcessLauncher(async (request) => {
      const currentMeasurement = createHash("sha256").update(await readFile(backendExecutable)).digest("hex");
      if (currentMeasurement !== backendMeasurement) {
        throw new Error("TraceForge Linux sandbox helper changed after startup; execution denied");
      }
      return compileLinuxStdioSandboxLaunch(request, {
        linuxHelperPath: backendExecutable,
        linuxCgroupRoot: linuxRuntime.cgroupRoot,
        linuxScratchRoot: linuxRuntime.scratchRoot,
        backendMeasurement,
        pathExists: existsSync,
      });
    });
    this.terminal = new NativeTerminalProcessLauncher(async (request) => {
      const currentMeasurement = createHash("sha256").update(await readFile(backendExecutable)).digest("hex");
      if (currentMeasurement !== backendMeasurement) {
        throw new Error("TraceForge Linux sandbox helper changed after startup; execution denied");
      }
      return compileLinuxPtySandboxLaunch(request, {
        linuxHelperPath: backendExecutable,
        linuxCgroupRoot: linuxRuntime.cgroupRoot,
        linuxScratchRoot: linuxRuntime.scratchRoot,
        backendMeasurement,
        pathExists: existsSync,
      });
    });
  }

  launch(request: StartProcessRequest, identity?: ProcessLaunchIdentity) {
    if (request.terminal) {
      return this.terminal.launch(request, identity);
    }
    return this.stdio.launch(request);
  }
}

class UnavailableProcessLauncher implements ProcessLauncher {
  async launch(_request: StartProcessRequest): Promise<never> {
    throw new Error("Execution Node has no enforceable process sandbox backend");
  }
}

export async function startLocalExecutionNodeService(
  projectRoot: string,
  authorization: ScenarioAuthorizationPort,
  sqlite: Database.Database,
): Promise<LocalExecutionNodeService> {
  const preflight = await preflightLocalExecutionNode({ projectRoot });
  const platform = preflight.platform, backendExecutable = preflight.executablePath;
  const linuxRuntime = preflight.linuxRuntime, backendMeasurement = preflight.helper?.measurement ?? null;
  const processReady = preflight.processReady, backend = preflight.backend ?? "traceforge-linux-native";
  const httpBroker = new BrokeredHttpGateway({
    authorizer: {
      authorize(input) {
        const grant = authorization.authorizeResource(
          input.attribution.scopeRef,
          input.attribution.caseId,
          input.authorizationAction,
          "network.url",
          input.url,
        );
        return {
          authorizationRef: grant.id,
          canonicalUrl: grant.canonicalValue,
          expiresAt: grant.expiresAt,
        };
      },
    },
  });
  const launcher = processReady && backendExecutable
    ? new PlatformSandboxLauncher(backendExecutable, backendMeasurement!, linuxRuntime ?? undefined)
    : new UnavailableProcessLauncher();
  const operationJournal = new SqliteProcessOperationJournal(sqlite);
  const node = new LocalExecutionNode(launcher, {
    processJournal: new SqliteProcessExecutionJournal(sqlite),
    operationJournal,
    platform,
    sandboxBackends: processReady ? [backend] : [],
    sandboxMeasurements: processReady && backendMeasurement ? { [backend]: backendMeasurement } : undefined,
    httpBroker,
    capabilities: {
      process: {
        spawn: processReady,
        stdio: processReady,
        tty: processReady,
        adoption: processReady,
        resourceLimits: processReady,
        signals: processReady ? ["interrupt", "terminate", "kill"] : [],
      },
    },
  });
  const authToken = createExecutionRpcAuthToken();
  const server = new ExecutionNodeRpcServer(new ExecutionRpcDispatcher(node), { authToken });
  const address = await server.listen(defaultExecutionRpcPipe(node.descriptor.id));
  const client = new ExecutionNodeRpcClient(address, { authToken });
  try {
    await client.handshake({
      clientId: "traceforge-security-agent-foundation",
      protocol: EXECUTION_PROTOCOL_VERSION,
      requiredCapabilities: ["network.brokered", "http.request", "filesystem.read", "filesystem.write"],
    });
  } catch (error) {
    client.disconnect();
    await server.close();
    throw error;
  }
  let health = await refreshLocalExecutionNodeHealth(preflight);
  const serviceHealth = (): LocalExecutionNodeServiceHealth => {
    const operationJournalStatus = processOperationJournalHealth(operationJournal.usage());
    if (health.state === "ready" && operationJournalStatus.state === "capacity_exhausted") {
      return { ...health, state: "degraded", processReady: false, terminalReady: false,
        reasonCode: "operation_journal_capacity_exhausted",
        recoveryHint: "Preserve uncertain operations and archive confirmed local operation history before starting more process controls.",
        operationJournal: operationJournalStatus };
    }
    return { ...health, operationJournal: operationJournalStatus };
  };
  return {
    client,
    get processReady() { return serviceHealth().processReady; },
    async health() {
      health = await refreshLocalExecutionNodeHealth(preflight);
      if (health.state === "ready") {
        try {
          await client.handshake({ clientId: "traceforge-security-agent-health", protocol: EXECUTION_PROTOCOL_VERSION,
            requiredCapabilities: ["network.brokered", "http.request", "filesystem.read", "filesystem.write"] });
        } catch {
          health = { ...health, state: "degraded", processReady: false, terminalReady: false,
            reasonCode: "local_rpc_unhealthy", recoveryHint: "Restart the local TraceForge host; no remote node is involved." };
        }
      }
      return structuredClone(serviceHealth());
    },
    async close() {
      client.disconnect();
      await server.close();
      await node.shutdown();
      health = { ...health, state: "stopped", processReady: false, terminalReady: false, checkedAt: new Date().toISOString(),
        reasonCode: "service_stopped", recoveryHint: null };
    },
  };
}
