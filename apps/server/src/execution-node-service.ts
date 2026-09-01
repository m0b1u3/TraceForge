import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BrokeredHttpGateway,
  EXECUTION_PROTOCOL_VERSION,
  ExecutionNodeRpcClient,
  ExecutionNodeRpcServer,
  ExecutionRpcDispatcher,
  LocalExecutionNode,
  NodeSpawnProcessLauncher,
  WindowsConptyProcessLauncher,
  compileLinuxStdioSandboxLaunch,
  compileWindowsConptySandboxLaunch,
  compileWindowsStdioSandboxLaunch,
  createExecutionRpcAuthToken,
  defaultExecutionRpcPipe,
  parseWindowsSandboxHelperProbe,
  type ExecutionNode,
  type ProcessLauncher,
  type ProcessLaunchIdentity,
  type StartProcessRequest,
} from "@traceforge/execution-node";
import type { ScenarioAuthorizationPort } from "@traceforge/scenario-sdk";
import type Database from "better-sqlite3";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";

export interface LocalExecutionNodeService {
  client: ExecutionNode;
  processReady: boolean;
  close(): Promise<void>;
}

const execFileAsync = promisify(execFile);

class PlatformSandboxLauncher implements ProcessLauncher {
  private readonly stdio: NodeSpawnProcessLauncher;
  private readonly conpty: WindowsConptyProcessLauncher | null;

  constructor(backendExecutable: string) {
    if (process.platform === "win32") {
      const options = { windowsHelperPath: backendExecutable, pathExists: existsSync };
      this.stdio = new NodeSpawnProcessLauncher((request) => compileWindowsStdioSandboxLaunch(request, options));
      this.conpty = new WindowsConptyProcessLauncher((request) => compileWindowsConptySandboxLaunch(request, options));
      return;
    }
    this.stdio = new NodeSpawnProcessLauncher((request) => compileLinuxStdioSandboxLaunch(request, {
      bubblewrapPath: backendExecutable,
      pathExists: existsSync,
    }));
    this.conpty = null;
  }

  launch(request: StartProcessRequest, identity?: ProcessLaunchIdentity) {
    if (request.terminal) {
      if (!this.conpty) throw new Error("This Execution Node does not provide a native PTY backend");
      return this.conpty.launch(request, identity);
    }
    return this.stdio.launch(request);
  }
}

class UnavailableProcessLauncher implements ProcessLauncher {
  async launch(_request: StartProcessRequest): Promise<never> {
    throw new Error("Execution Node has no enforceable process sandbox backend");
  }
}

function resolveSandboxBackend(projectRoot: string): string | null {
  if (process.platform === "win32") {
    const configured = process.env.TRACEFORGE_WINDOWS_SANDBOX_HELPER?.trim();
    if (configured) {
      const explicit = resolve(configured);
      return existsSync(explicit) ? explicit : null;
    }
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const helper = [sourceRoot, projectRoot]
      .map((root) => resolve(root, "packages/execution-node/native/win32-x64/traceforge-windows-sandbox.exe"))
      .find(existsSync);
    return helper ?? null;
  }
  return ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync) ?? null;
}

async function probeSandboxBackend(executable: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(executable, ["probe"], { timeout: 5_000, windowsHide: true });
      parseWindowsSandboxHelperProbe(stdout);
      return true;
    }
    await execFileAsync(executable, ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function startLocalExecutionNodeService(
  projectRoot: string,
  authorization: ScenarioAuthorizationPort,
  sqlite: Database.Database,
): Promise<LocalExecutionNodeService> {
  const platform = process.platform === "win32" ? "windows" as const
    : process.platform === "darwin" ? "darwin" as const : "linux" as const;
  const backendExecutable = resolveSandboxBackend(projectRoot);
  const sandboxBackendReady = Boolean(backendExecutable && await probeSandboxBackend(backendExecutable));
  const processReady = platform === "windows" && sandboxBackendReady;
  const backend = platform === "windows" ? "traceforge-windows-native" : "bubblewrap";
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
    ? new PlatformSandboxLauncher(backendExecutable)
    : new UnavailableProcessLauncher();
  const node = new LocalExecutionNode(launcher, {
    processJournal: new SqliteProcessExecutionJournal(sqlite),
    platform,
    sandboxBackends: processReady ? [backend] : [],
    httpBroker,
    capabilities: {
      process: {
        spawn: processReady,
        stdio: processReady,
        tty: processReady && platform === "windows",
        adoption: processReady,
        resourceLimits: processReady && platform === "windows",
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
  return {
    client,
    processReady,
    async close() {
      client.disconnect();
      await server.close();
    },
  };
}
