export const WINDOWS_SANDBOX_HELPER_PROTOCOL = 2 as const;

export const WINDOWS_SANDBOX_HELPER_MODES = [
  "unelevated-direct",
  "appcontainer-deny",
] as const;

export const WINDOWS_SANDBOX_RESOURCE_LIMITS = [
  "cpu_time",
  "memory",
  "process_count",
  "write_bytes",
] as const;

export interface WindowsSandboxHelperProbe {
  protocol: typeof WINDOWS_SANDBOX_HELPER_PROTOCOL;
  platform: "windows";
  modes: Array<(typeof WINDOWS_SANDBOX_HELPER_MODES)[number]>;
  pty: true;
  resourceLimits: Array<(typeof WINDOWS_SANDBOX_RESOURCE_LIMITS)[number]>;
}

export function parseWindowsSandboxHelperProbe(output: string): WindowsSandboxHelperProbe {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new Error("Windows sandbox helper probe returned invalid JSON");
  }
  if (!value || typeof value !== "object") throw new Error("Windows sandbox helper probe returned no object");
  const probe = value as Record<string, unknown>;
  if (probe.protocol !== WINDOWS_SANDBOX_HELPER_PROTOCOL || probe.platform !== "windows" || probe.pty !== true) {
    throw new Error("Windows sandbox helper probe reported an incompatible protocol");
  }
  if (!Array.isArray(probe.modes)) {
    throw new Error("Windows sandbox helper probe is missing a required isolation mode");
  }
  const modes = probe.modes;
  if (WINDOWS_SANDBOX_HELPER_MODES.some((mode) => !modes.includes(mode))) {
    throw new Error("Windows sandbox helper probe is missing a required isolation mode");
  }
  const resourceLimits = probe.resourceLimits;
  if (!Array.isArray(resourceLimits)
    || WINDOWS_SANDBOX_RESOURCE_LIMITS.some((resource) => !resourceLimits.includes(resource))) {
    throw new Error("Windows sandbox helper probe is missing a required resource limit");
  }
  return {
    protocol: WINDOWS_SANDBOX_HELPER_PROTOCOL,
    platform: "windows",
    modes: [...WINDOWS_SANDBOX_HELPER_MODES],
    pty: true,
    resourceLimits: [...WINDOWS_SANDBOX_RESOURCE_LIMITS],
  };
}
