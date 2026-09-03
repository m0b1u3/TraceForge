import { describe, expect, it } from "vitest";
import { parseLinuxSandboxHelperProbe, parseLinuxSandboxHelperRecovery } from "./linux-helper-contract.js";

const probe = {
  protocol: 2, platform: "linux", modes: ["namespace-cgroup-seccomp-deny"],
  namespaces: ["user", "mount", "pid", "ipc", "uts", "network"],
  resourceLimits: ["cpu_time", "memory", "process_count", "write_bytes"],
  cgroupV2: true, cgroupKill: true, pidfd: true, seccomp: true, noNewPrivileges: true,
  filesystemPolicy: true, terminal: true, atomicCgroupAssignment: true, cgroupEmptyBarrier: true,
};

describe("Linux sandbox helper contract", () => {
  it("preserves the helper's exact supported modes after validating the complete proof", () => {
    expect(parseLinuxSandboxHelperProbe(JSON.stringify(probe))).toEqual(probe);
  });

  it("rejects older, partial, unknown or overclaimed helpers", () => {
    expect(() => parseLinuxSandboxHelperProbe("not-json")).toThrow(/invalid JSON/);
    expect(() => parseLinuxSandboxHelperProbe(JSON.stringify({ ...probe, protocol: 0 }))).toThrow(/incompatible/);
    for (const patch of [
      { cgroupKill: false },
      { atomicCgroupAssignment: false },
      { cgroupEmptyBarrier: false },
      { terminal: false },
      { seccomp: false },
      { namespaces: ["mount", "pid"] },
      { modes: ["namespace-cgroup-seccomp-deny", "invented-mode"] },
    ]) {
      expect(() => parseLinuxSandboxHelperProbe(JSON.stringify({ ...probe, ...patch }))).toThrow(/missing|misreporting/);
    }
  });

  it("validates bounded startup recovery reports", () => {
    expect(parseLinuxSandboxHelperRecovery(JSON.stringify({
      protocol: 2, recoveredCgroups: 2, recoveredScratchTrees: 3,
    }))).toEqual({ protocol: 2, recoveredCgroups: 2, recoveredScratchTrees: 3 });
    expect(() => parseLinuxSandboxHelperRecovery(JSON.stringify({
      protocol: 2, recoveredCgroups: -1, recoveredScratchTrees: 0,
    }))).toThrow(/misreported/);
  });
});
