import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { allowsFileSystemPath, type EffectivePermissionProfile, type PermissionPathGrant } from "@traceforge/orchestration-core";
import { permissionProfileFingerprint, resourceLimitsFingerprint, type StartProcessRequest } from "./protocol.js";
import type { SpawnLaunchSpec } from "./runtime.js";
import type { NativeTerminalLaunchSpec, WindowsConptyLaunchSpec } from "./native-terminal.js";

export interface SandboxPolicyCompilerOptions {
  windowsHelperPath?: string;
  linuxHelperPath?: string;
  linuxCgroupRoot?: string;
  linuxScratchRoot?: string;
  backendMeasurement?: string;
  pathExists?: (path: string) => boolean;
  pathKind?: (path: string) => "file" | "directory" | "other";
}

function assertCommon(request: StartProcessRequest, expectedPlatform: EffectivePermissionProfile["platform"]): void {
  if (request.permissions.platform !== expectedPlatform) {
    throw new Error(`Sandbox compiler for ${expectedPlatform} received ${request.permissions.platform} permissions`);
  }
  if (request.permissions.process.access === "deny") throw new Error("Effective permission profile denies process execution");
  if (!allowsFileSystemPath(request.permissions, "read", request.executable)) {
    throw new Error("Effective permission profile does not grant read access to the executable");
  }
  if (!allowsFileSystemPath(request.permissions, "read", request.workingDirectory)) {
    throw new Error("Effective permission profile does not grant read access to the working directory");
  }
}

function assertExistingPolicyPaths(profile: EffectivePermissionProfile, pathExists: (path: string) => boolean): void {
  for (const grant of [...profile.filesystem.read, ...profile.filesystem.write, ...profile.filesystem.deny]) {
    const absolute = profile.platform === "windows" ? win32.isAbsolute(grant.path) : isAbsolute(grant.path);
    if (!absolute) throw new Error(`Sandbox policy path must be absolute: ${grant.path}`);
    if (!pathExists(grant.path)) {
      throw new Error(`Sandbox cannot prove a policy for missing path ${grant.path}; execution denied`);
    }
  }
}

function windowsGrantArguments(profile: EffectivePermissionProfile): string[] {
  const args: string[] = [];
  const append = (kind: "read" | "write" | "deny", grants: PermissionPathGrant[]) => {
    for (const grant of grants) args.push(`--${kind}-${grant.scope}`, grant.path);
  };
  append("read", profile.filesystem.read);
  append("write", profile.filesystem.write);
  append("deny", profile.filesystem.deny);
  return args;
}

function resourceLimitArguments(request: StartProcessRequest): string[] {
  return [
    "--cpu-time-ms", String(request.resources.cpuTimeMs),
    "--memory-bytes", String(request.resources.memoryBytes),
    "--max-processes", String(request.resources.maximumProcesses),
    "--write-bytes", String(request.resources.writeBytes),
  ];
}

function resourceLimitStatusPath(): string {
  return join(tmpdir(), `traceforge-resource-limit-${randomUUID()}.status`);
}

function windowsPolicy(
  request: StartProcessRequest,
  options: SandboxPolicyCompilerOptions,
): {
  helper: string;
  mode: "unelevated" | "appcontainer";
  networkArgument: "allow" | "deny";
  profileArguments: string[];
  enforcement: SpawnLaunchSpec["enforcement"];
} {
  assertCommon(request, "windows");
  const pathExists = options.pathExists ?? existsSync;
  assertExistingPolicyPaths(request.permissions, pathExists);
  const helper = options.windowsHelperPath?.trim();
  if (!helper || !pathExists(helper)) throw new Error("TraceForge Windows sandbox helper is missing; execution denied");
  if (request.permissions.network === "brokered") {
    throw new Error("Windows sandbox brokered network transport is not installed; execution denied");
  }
  const networkIsolated = request.permissions.network === "deny";
  return {
    helper,
    mode: networkIsolated ? "appcontainer" : "unelevated",
    networkArgument: networkIsolated ? "deny" : "allow",
    profileArguments: windowsGrantArguments(request.permissions),
    enforcement: {
      sandboxBackend: "traceforge-windows-native",
      backendMeasurement: options.backendMeasurement,
      sandboxed: true,
      filesystemPolicyApplied: true,
      permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
      resourceLimitsApplied: true,
      resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources),
      network: request.permissions.network,
    },
  };
}

export function compileWindowsStdioSandboxLaunch(
  request: StartProcessRequest,
  options: SandboxPolicyCompilerOptions,
): SpawnLaunchSpec {
  if (request.terminal) throw new Error("Windows stdio sandbox compiler does not accept a terminal request");
  const policy = windowsPolicy(request, options);
  const statusFile = resourceLimitStatusPath();
  return {
    executable: policy.helper,
    arguments: [
      "run", "--mode", policy.mode, "--network", policy.networkArgument, "--cwd", request.workingDirectory,
      "--status-file", statusFile,
      ...resourceLimitArguments(request),
      ...policy.profileArguments,
      request.executable,
      ...request.arguments,
    ],
    workingDirectory: request.workingDirectory,
    environment: { ...request.environment },
    detached: false,
    windowsHide: true,
    enforcement: policy.enforcement,
    resourceLimitStatusFile: statusFile,
    terminate: (child) => terminateHelper(child),
  };
}

export function compileWindowsConptySandboxLaunch(
  request: StartProcessRequest,
  options: SandboxPolicyCompilerOptions,
): WindowsConptyLaunchSpec {
  if (!request.terminal) throw new Error("Windows ConPTY sandbox compiler requires a terminal request");
  const policy = windowsPolicy(request, options);
  return {
    helperExecutable: policy.helper,
    helperEnvironment: { ...request.environment },
    mode: policy.mode,
    profileArguments: [...resourceLimitArguments(request), ...policy.profileArguments],
    enforcement: policy.enforcement,
  };
}

function terminateHelper(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) return;
  if (!child.kill("SIGKILL")) throw new Error("Operating system rejected sandbox helper termination");
}

export function compileLinuxStdioSandboxLaunch(
  request: StartProcessRequest,
  options: SandboxPolicyCompilerOptions,
): SpawnLaunchSpec {
  if (request.terminal) throw new Error("Linux stdio sandbox compiler does not provide a PTY");
  const policy = linuxPolicy(request, options);
  return {
    executable: policy.helper,
    arguments: [
      "run", "--network", request.permissions.network, "--cwd", request.workingDirectory,
      "--status-file", policy.statusFile, "--cgroup-root", policy.cgroupRoot, "--scratch-root", policy.scratchRoot,
      ...resourceLimitArguments(request), ...policy.grantArguments,
      "--", request.executable, ...request.arguments,
    ],
    workingDirectory: request.workingDirectory,
    environment: policy.targetEnvironment,
    detached: false,
    windowsHide: true,
    resourceLimitStatusFile: policy.statusFile,
    enforcement: policy.enforcement,
  };
}

export function compileLinuxPtySandboxLaunch(
  request: StartProcessRequest,
  options: SandboxPolicyCompilerOptions,
): NativeTerminalLaunchSpec {
  if (!request.terminal) throw new Error("Linux PTY sandbox compiler requires a terminal request");
  const policy = linuxPolicy(request, options);
  return {
    helperExecutable: policy.helper,
    helperEnvironment: policy.targetEnvironment,
    modeArguments: [],
    commandSeparator: ["--"],
    profileArguments: [
      "--status-file", policy.statusFile, "--cgroup-root", policy.cgroupRoot, "--scratch-root", policy.scratchRoot,
      ...resourceLimitArguments(request), ...policy.grantArguments,
    ],
    enforcement: policy.enforcement,
  };
}

function linuxPolicy(request: StartProcessRequest, options: SandboxPolicyCompilerOptions) {
  if (request.permissions.network !== "deny") {
    throw new Error("Linux native helper supports only denied process networking");
  }
  assertCommon(request, "linux");
  const pathExists = options.pathExists ?? existsSync;
  assertExistingPolicyPaths(request.permissions, pathExists);
  const helper = options.linuxHelperPath?.trim();
  if (!helper || !pathExists(helper)) {
    throw new Error("TraceForge Linux sandbox helper is missing; execution denied");
  }
  const cgroupRoot = options.linuxCgroupRoot?.trim();
  const scratchRoot = options.linuxScratchRoot?.trim();
  if (!cgroupRoot || !isAbsolute(cgroupRoot) || !scratchRoot || !isAbsolute(scratchRoot)) {
    throw new Error("TraceForge Linux sandbox runtime directories are unavailable; execution denied");
  }
  const statusFile = resourceLimitStatusPath();
  const grants = (kind: "read" | "write" | "deny", values: PermissionPathGrant[]) => (
    values.flatMap((item) => [`--${kind}-${item.scope}`, item.path])
  );
  // The helper must not inherit host variables such as LD_PRELOAD. Only the encoded target map is exposed.
  const targetEnvironment = Object.fromEntries(Object.entries(request.environment).map(([key, value]) => [
    `TRACEFORGE_TARGET_ENV_${Buffer.from(key).toString("hex")}`,
    Buffer.from(value).toString("hex"),
  ]));
  return {
    helper, cgroupRoot, scratchRoot, statusFile, targetEnvironment,
    grantArguments: [
      ...grants("read", request.permissions.filesystem.read),
      ...grants("write", request.permissions.filesystem.write),
      ...grants("deny", request.permissions.filesystem.deny),
    ],
    enforcement: {
      sandboxBackend: "traceforge-linux-native",
      backendMeasurement: options.backendMeasurement,
      sandboxed: true,
      filesystemPolicyApplied: true,
      permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
      resourceLimitsApplied: true,
      resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources),
      network: request.permissions.network,
      atomicProcessTreeAssignment: true,
      processTreeEmptyBarrier: true,
      linux: {
        namespaces: ["user", "mount", "pid", "ipc", "uts", "network"],
        cgroupV2: true,
        seccomp: true,
        noNewPrivileges: true,
      },
    } satisfies SpawnLaunchSpec["enforcement"],
  };
}
