import { describe, expect, it } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import { permissionProfileFingerprint, type StartProcessRequest } from "./protocol.js";
import {
  compileLinuxStdioSandboxLaunch,
  compileWindowsConptySandboxLaunch,
  compileWindowsStdioSandboxLaunch,
} from "./sandbox-policy.js";

function request(platform: EffectivePermissionProfile["platform"]): StartProcessRequest {
  const windows = platform === "windows";
  const workspace = windows ? "C:\\cases\\case_1" : "/cases/case_1";
  const executable = windows ? "C:\\Runtime\\node.exe" : "/runtime/bin/node";
  return {
    requestId: "request_policy",
    attribution: {
      caseId: "case_1", runId: "run_1", workId: "work_1", workerId: "worker_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: "2099-01-01T00:00:00.000Z", actionId: "action_1", idempotencyKey: "effect_1",
    },
    executable,
    arguments: ["script.js"],
    workingDirectory: workspace,
    environment: { LANG: "C.UTF-8" },
    stdin: "closed",
    timeoutMs: 60_000,
    outputLimitBytes: 4096,
    resources: { cpuTimeMs: 30_000, memoryBytes: 256 * 1024 * 1024, maximumProcesses: 8, writeBytes: 64 * 1024 * 1024 },
    permissions: {
      version: 1,
      platform,
      filesystem: {
        read: [
          { path: windows ? "C:\\Runtime" : "/runtime", scope: "tree" },
          { path: workspace, scope: "tree" },
        ],
        write: [{ path: workspace, scope: "tree" }],
        deny: [{ path: windows ? `${workspace}\\private` : `${workspace}/private`, scope: "tree" }],
      },
      network: "direct",
      process: { access: "sandboxed", interactive: false, background: false },
      secrets: "deny",
      sources: ["platform", "scenario", "tool"],
    },
  };
}

describe("Execution Node sandbox policy compiler", () => {
  it("compiles the exact Windows profile into native helper arguments and a bound proof", () => {
    const input = request("windows");
    const spec = compileWindowsStdioSandboxLaunch(input, {
      windowsHelperPath: "C:\\TraceForge\\traceforge-windows-sandbox.exe",
      pathExists: () => true,
    });
    expect(spec.executable).toBe("C:\\TraceForge\\traceforge-windows-sandbox.exe");
    expect(spec.arguments).toEqual([
      "run", "--mode", "unelevated", "--network", "allow", "--cwd", "C:\\cases\\case_1",
      "--status-file", expect.stringMatching(/traceforge-resource-limit-[a-f0-9-]{36}\.status$/),
      "--cpu-time-ms", "30000", "--memory-bytes", "268435456", "--max-processes", "8", "--write-bytes", "67108864",
      "--read-tree", "C:\\Runtime",
      "--read-tree", "C:\\cases\\case_1",
      "--write-tree", "C:\\cases\\case_1",
      "--deny-tree", "C:\\cases\\case_1\\private",
      "C:\\Runtime\\node.exe", "script.js",
    ]);
    expect(spec.enforcement).toMatchObject({
      sandboxBackend: "traceforge-windows-native",
      filesystemPolicyApplied: true,
      permissionProfileFingerprint: permissionProfileFingerprint(input.permissions),
      network: "direct",
    });
  });

  it("uses the same profiled helper contract for ConPTY", () => {
    const input = request("windows");
    input.terminal = { columns: 100, rows: 30 };
    input.permissions.process.interactive = true;
    const spec = compileWindowsConptySandboxLaunch(input, {
      windowsHelperPath: "C:\\TraceForge\\traceforge-windows-sandbox.exe",
      pathExists: () => true,
    });
    expect(spec.profileArguments).toContain("--deny-tree");
    expect(spec.enforcement.permissionProfileFingerprint).toBe(permissionProfileFingerprint(input.permissions));
  });

  it("compiles Windows network denial into AppContainer mode and rejects unsupported broker transport", () => {
    const deniedNetwork = request("windows");
    deniedNetwork.permissions.network = "deny";
    const denied = compileWindowsStdioSandboxLaunch(deniedNetwork, {
      windowsHelperPath: "C:\\TraceForge\\traceforge-windows-sandbox.exe", pathExists: () => true,
    });
    expect(denied.arguments.slice(0, 5)).toEqual([
      "run", "--mode", "appcontainer", "--network", "deny",
    ]);
    expect(denied.enforcement.network).toBe("deny");

    const brokered = request("windows");
    brokered.permissions.network = "brokered";
    expect(() => compileWindowsStdioSandboxLaunch(brokered, {
      windowsHelperPath: "C:\\TraceForge\\traceforge-windows-sandbox.exe", pathExists: () => true,
    })).toThrow(/brokered network transport is not installed/);

    const missing = request("windows");
    expect(() => compileWindowsStdioSandboxLaunch(missing, {
      windowsHelperPath: "C:\\TraceForge\\traceforge-windows-sandbox.exe",
      pathExists: (path) => !path.endsWith("private"),
    })).toThrow(/missing path.*execution denied/);
  });

  it("fails closed on Linux until a managed cgroup backend can prove process-tree quotas", () => {
    const input = request("linux");
    input.permissions.network = "deny";
    expect(() => compileLinuxStdioSandboxLaunch(input, {
      bubblewrapPath: "/usr/bin/bwrap",
      pathExists: () => true,
      pathKind: (path) => path.endsWith("private") ? "directory" : path.endsWith("node") ? "file" : "directory",
    })).toThrow(/managed cgroup execution backend/);
  });
});
