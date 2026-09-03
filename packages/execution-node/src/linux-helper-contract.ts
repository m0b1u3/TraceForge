export const LINUX_SANDBOX_HELPER_PROTOCOL = 2 as const;
export const LINUX_SANDBOX_MODES = [
  "namespace-cgroup-seccomp-deny",
  "namespace-cgroup-seccomp-brokered",
  "namespace-cgroup-seccomp-direct",
] as const;
export const LINUX_SANDBOX_REQUIRED_MODES = ["namespace-cgroup-seccomp-deny"] as const;
export const LINUX_SANDBOX_NAMESPACES = ["user", "mount", "pid", "ipc", "uts", "network"] as const;
export const LINUX_SANDBOX_RESOURCE_LIMITS = ["cpu_time", "memory", "process_count", "write_bytes"] as const;

export interface LinuxSandboxHelperProbe {
  protocol: typeof LINUX_SANDBOX_HELPER_PROTOCOL;
  platform: "linux";
  modes: Array<typeof LINUX_SANDBOX_MODES[number]>;
  namespaces: Array<typeof LINUX_SANDBOX_NAMESPACES[number]>;
  resourceLimits: Array<typeof LINUX_SANDBOX_RESOURCE_LIMITS[number]>;
  cgroupV2: true;
  cgroupKill: true;
  pidfd: true;
  seccomp: true;
  noNewPrivileges: true;
  filesystemPolicy: true;
  terminal: true;
  atomicCgroupAssignment: true;
  cgroupEmptyBarrier: true;
}

export interface LinuxSandboxHelperRecovery {
  protocol: typeof LINUX_SANDBOX_HELPER_PROTOCOL;
  recoveredCgroups: number;
  recoveredScratchTrees: number;
}

export function parseLinuxSandboxHelperRecovery(output: string): LinuxSandboxHelperRecovery {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new Error("Linux sandbox helper recovery returned invalid JSON");
  }
  if (!value || typeof value !== "object") throw new Error("Linux sandbox helper recovery returned no object");
  const recovery = value as Record<string, unknown>;
  if (recovery.protocol !== LINUX_SANDBOX_HELPER_PROTOCOL) {
    throw new Error("Linux sandbox helper recovery reported an incompatible protocol");
  }
  for (const name of ["recoveredCgroups", "recoveredScratchTrees"] as const) {
    if (!Number.isSafeInteger(recovery[name]) || (recovery[name] as number) < 0) {
      throw new Error(`Linux sandbox helper recovery misreported ${name}`);
    }
  }
  return recovery as unknown as LinuxSandboxHelperRecovery;
}

export function parseLinuxSandboxHelperProbe(output: string): LinuxSandboxHelperProbe {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new Error("Linux sandbox helper probe returned invalid JSON");
  }
  if (!value || typeof value !== "object") throw new Error("Linux sandbox helper probe returned no object");
  const probe = value as Record<string, unknown>;
  if (probe.protocol !== LINUX_SANDBOX_HELPER_PROTOCOL || probe.platform !== "linux") {
    throw new Error("Linux sandbox helper probe reported an incompatible protocol");
  }
  const arrays = [
    ["modes", LINUX_SANDBOX_MODES, LINUX_SANDBOX_REQUIRED_MODES],
    ["namespaces", LINUX_SANDBOX_NAMESPACES, LINUX_SANDBOX_NAMESPACES],
    ["resourceLimits", LINUX_SANDBOX_RESOURCE_LIMITS, LINUX_SANDBOX_RESOURCE_LIMITS],
  ] as const;
  for (const [name, allowed, required] of arrays) {
    const actual = probe[name];
    if (!Array.isArray(actual)
      || actual.some((item) => !allowed.includes(item as never))
      || required.some((item) => !actual.includes(item))) {
      throw new Error(`Linux sandbox helper is missing or misreporting ${name}`);
    }
  }
  for (const name of [
    "cgroupV2", "cgroupKill", "pidfd", "seccomp", "noNewPrivileges", "filesystemPolicy", "terminal",
    "atomicCgroupAssignment", "cgroupEmptyBarrier",
  ] as const) {
    if (probe[name] !== true) throw new Error(`Linux sandbox helper is missing ${name}`);
  }
  return probe as unknown as LinuxSandboxHelperProbe;
}
