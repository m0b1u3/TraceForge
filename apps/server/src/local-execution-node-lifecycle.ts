import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  LINUX_SANDBOX_HELPER_PROTOCOL,
  WINDOWS_SANDBOX_HELPER_PROTOCOL,
  parseLinuxSandboxHelperProbe,
  parseLinuxSandboxHelperRecovery,
  parseWindowsSandboxHelperProbe,
  verifyNativeHelperRelease,
  type LinuxSandboxHelperRecovery,
} from "@traceforge/execution-node";

export interface LinuxSandboxRuntime {
  cgroupRoot: string;
  scratchRoot: string;
}

export type LocalExecutionNodeHealthState = "ready" | "unavailable" | "degraded" | "stopped";

export interface LocalExecutionNodeHealth {
  schemaVersion: 1;
  state: LocalExecutionNodeHealthState;
  platform: "windows" | "linux" | "darwin";
  architecture: string;
  processReady: boolean;
  terminalReady: boolean;
  backend: "traceforge-windows-native" | "traceforge-linux-native" | null;
  helper: null | {
    source: "configured" | "bundled";
    executable: string;
    releaseManifest: "verified" | "not_required";
    measurement: string;
  };
  startupCleanup: null | { recoveredProcessTrees: number; recoveredScratchTrees: number };
  checkedAt: string;
  reasonCode: string | null;
  recoveryHint: string | null;
}

export interface LocalExecutionNodePreflight extends LocalExecutionNodeHealth {
  executablePath: string | null;
  helperSize: number | null;
  linuxRuntime: LinuxSandboxRuntime | null;
}

interface PreflightOptions {
  projectRoot: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  env?: NodeJS.ProcessEnv;
  sourceRoot?: string;
  now?: () => string;
  execute?: (file: string, args: string[], timeoutMs: number) => Promise<string>;
}

const execFileAsync = promisify(execFile);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const runtimePlatform = (platform: NodeJS.Platform): LocalExecutionNodeHealth["platform"] => platform === "win32" ? "windows" : platform === "linux" ? "linux" : "darwin";

function unavailable(
  platform: LocalExecutionNodeHealth["platform"], architecture: string, checkedAt: string,
  reasonCode: string, recoveryHint: string,
): LocalExecutionNodePreflight {
  return { schemaVersion: 1, state: "unavailable", platform, architecture, processReady: false, terminalReady: false,
    backend: null, helper: null, startupCleanup: null, checkedAt, reasonCode, recoveryHint, executablePath: null, helperSize: null, linuxRuntime: null };
}

export async function preflightLocalExecutionNode(options: PreflightOptions): Promise<LocalExecutionNodePreflight> {
  const hostPlatform = options.platform ?? process.platform, platform = runtimePlatform(hostPlatform);
  const architecture = options.architecture ?? process.arch, env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString()), checkedAt = now();
  if (!(["win32", "linux"] as NodeJS.Platform[]).includes(hostPlatform)) {
    return unavailable(platform, architecture, checkedAt, "platform_not_supported", "Install on an accepted Windows or Linux host to enable sandboxed process execution.");
  }
  if (architecture !== "x64") return unavailable(platform, architecture, checkedAt, "architecture_not_supported", "Use an accepted x64 native helper build for this host.");

  if (hostPlatform === "linux" && env.TRACEFORGE_LINUX_DEPLOYMENT_STATUS === "portable_or_direct_launch") {
    return unavailable(platform, architecture, checkedAt, "linux_deployment_not_installed",
      "Install and launch the supported DEB build so systemd delegation and AppArmor policy can be proven.");
  }

  const windows = hostPlatform === "win32";
  const nativePlatform: "windows" | "linux" = windows ? "windows" : "linux";
  const backend = windows ? "traceforge-windows-native" as const : "traceforge-linux-native" as const;
  const executable = windows ? "traceforge-windows-sandbox.exe" : "traceforge-linux-sandbox";
  const configured = env[windows ? "TRACEFORGE_WINDOWS_SANDBOX_HELPER" : "TRACEFORGE_LINUX_SANDBOX_HELPER"]?.trim();
  const sourceRoot = options.sourceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const candidates = configured ? [resolve(configured)] : [sourceRoot, options.projectRoot]
    .map(root => resolve(root, `packages/execution-node/native/${windows ? "win32-x64" : "linux-x64"}/${executable}`));
  const executablePath = candidates.find(path => existsSync(path));
  if (!executablePath) return unavailable(platform, architecture, checkedAt, "helper_missing", "Repair or reinstall the local native helper for this platform.");
  try {
    const metadata = statSync(executablePath);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 128 * 1024 * 1024
      || (!windows && (metadata.mode & 0o111) === 0)) throw new Error("not executable");
  } catch {
    return unavailable(platform, architecture, checkedAt, "helper_not_executable", "Repair the helper file type and executable permissions, then restart TraceForge.");
  }

  const bytes = await readFile(executablePath).catch(() => null), expectedProtocol = windows ? WINDOWS_SANDBOX_HELPER_PROTOCOL : LINUX_SANDBOX_HELPER_PROTOCOL;
  if (!bytes) return unavailable(platform, architecture, checkedAt, "helper_unreadable", "Repair the local helper installation and restart TraceForge.");
  const manifestPath = env.TRACEFORGE_NATIVE_HELPER_RELEASE_MANIFEST?.trim()
    ? resolve(env.TRACEFORGE_NATIVE_HELPER_RELEASE_MANIFEST) : resolve(dirname(executablePath), "release.json");
  let releaseManifest: "verified" | "not_required" = "not_required";
  if (existsSync(manifestPath)) {
    try {
      const metadata = statSync(manifestPath);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > 16 * 1024) throw new Error("manifest size is invalid");
      verifyNativeHelperRelease(JSON.parse(readFileSync(manifestPath, "utf8")), {
        platform: nativePlatform, architecture, backend, executable: basename(executablePath), protocol: expectedProtocol, bytes,
      });
      releaseManifest = "verified";
    } catch {
      return unavailable(platform, architecture, checkedAt, "release_manifest_invalid", "Reinstall the complete TraceForge release; its helper manifest and executable do not match.");
    }
  } else if (env.TRACEFORGE_REQUIRE_NATIVE_HELPER_RELEASE_MANIFEST === "1") {
    return unavailable(platform, architecture, checkedAt, "release_manifest_missing", "Reinstall the complete TraceForge release; packaged helpers require their bundled release inventory entry.");
  }

  let linuxRuntime: LinuxSandboxRuntime | null = null;
  if (!windows) {
    const cgroupRoot = env.TRACEFORGE_LINUX_CGROUP_ROOT?.trim(), configuredScratch = env.TRACEFORGE_LINUX_SANDBOX_SCRATCH_ROOT?.trim();
    if (!cgroupRoot || !isAbsolute(cgroupRoot) || (configuredScratch && !isAbsolute(configuredScratch))) {
      return unavailable(platform, architecture, checkedAt, "linux_runtime_not_configured", "Configure an absolute delegated cgroup v2 root and private scratch directory.");
    }
    linuxRuntime = { cgroupRoot, scratchRoot: configuredScratch || resolve(options.projectRoot, "data/linux-sandbox") };
  }

  const execute = options.execute ?? (async (file: string, args: string[], timeoutMs: number) => {
    const { stdout } = await execFileAsync(file, args, { timeout: timeoutMs, windowsHide: true }); return stdout;
  });
  let cleanup: LinuxSandboxHelperRecovery | null = null;
  try {
    if (windows) parseWindowsSandboxHelperProbe(await execute(executablePath, ["probe"], 5_000));
    else {
      cleanup = parseLinuxSandboxHelperRecovery(await execute(executablePath, ["recover", "--cgroup-root", linuxRuntime!.cgroupRoot,
        "--scratch-root", linuxRuntime!.scratchRoot], 10_000));
      parseLinuxSandboxHelperProbe(await execute(executablePath, ["probe", "--cgroup-root", linuxRuntime!.cgroupRoot,
        "--scratch-root", linuxRuntime!.scratchRoot], 10_000));
    }
  } catch {
    return unavailable(platform, architecture, checkedAt, "native_probe_failed", "Review native helper, OS policy and delegated resource configuration; process execution remains disabled.");
  }
  return { schemaVersion: 1, state: "ready", platform, architecture, processReady: true, terminalReady: true,
    backend, helper: { source: configured ? "configured" : "bundled", executable, releaseManifest, measurement: digest(bytes) },
    startupCleanup: cleanup ? { recoveredProcessTrees: cleanup.recoveredCgroups, recoveredScratchTrees: cleanup.recoveredScratchTrees } : null,
    checkedAt, reasonCode: null, recoveryHint: null, executablePath, helperSize: bytes.length, linuxRuntime };
}

export async function refreshLocalExecutionNodeHealth(
  preflight: LocalExecutionNodePreflight,
  now: () => string = () => new Date().toISOString(),
): Promise<LocalExecutionNodeHealth> {
  const { executablePath: _path, helperSize: _size, linuxRuntime: _runtime, ...publicStatus } = preflight;
  if (preflight.state !== "ready" || !preflight.executablePath || !preflight.helper) return { ...publicStatus, checkedAt: now() };
  try {
    const metadata = statSync(preflight.executablePath);
    if (!metadata.isFile() || metadata.size !== preflight.helperSize) throw new Error("helper size changed");
    const measurement = digest(await readFile(preflight.executablePath));
    if (measurement !== preflight.helper.measurement) throw new Error("measurement changed");
    return { ...publicStatus, checkedAt: now() };
  } catch {
    return { ...publicStatus, state: "degraded", processReady: false, terminalReady: false, checkedAt: now(),
      reasonCode: "helper_measurement_changed", recoveryHint: "Stop running work, repair or roll back the complete local release, then restart TraceForge." };
  }
}
