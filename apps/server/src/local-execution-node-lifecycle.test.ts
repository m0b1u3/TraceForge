import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeHelperReleaseManifest } from "@traceforge/execution-node";
import { preflightLocalExecutionNode, refreshLocalExecutionNodeHealth } from "./local-execution-node-lifecycle.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync("/private/tmp/traceforge-local-node-"); roots.push(root);
  const helper = join(root, "traceforge-linux-sandbox"), bytes = Buffer.from("reviewed-helper"); writeFileSync(helper, bytes); chmodSync(helper, 0o755);
  const manifest = createNativeHelperReleaseManifest({ platform: "linux", protocol: 2, bytes });
  const manifestPath = join(root, "release.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
  const env = { TRACEFORGE_LINUX_SANDBOX_HELPER: helper, TRACEFORGE_NATIVE_HELPER_RELEASE_MANIFEST: manifestPath,
    TRACEFORGE_REQUIRE_NATIVE_HELPER_RELEASE_MANIFEST: "1", TRACEFORGE_LINUX_CGROUP_ROOT: join(root, "cgroup"), TRACEFORGE_LINUX_SANDBOX_SCRATCH_ROOT: join(root, "scratch") };
  const execute = async (_file: string, args: string[]) => args[0] === "recover"
    ? JSON.stringify({ protocol: 2, recoveredCgroups: 2, recoveredScratchTrees: 3 })
    : JSON.stringify({ protocol: 2, platform: "linux", modes: ["namespace-cgroup-seccomp-deny"], namespaces: ["user", "mount", "pid", "ipc", "uts", "network"],
      resourceLimits: ["cpu_time", "memory", "process_count", "write_bytes"], cgroupV2: true, cgroupKill: true, pidfd: true, seccomp: true,
      noNewPrivileges: true, filesystemPolicy: true, terminal: true, atomicCgroupAssignment: true, cgroupEmptyBarrier: true });
  return { root, helper, manifestPath, env, execute };
}

describe("local Execution Node lifecycle", () => {
  it("verifies packaged material, recovers residues and reports a secret-free ready status", async () => {
    const f = fixture(); const status = await preflightLocalExecutionNode({ projectRoot: f.root, platform: "linux", architecture: "x64", env: f.env, execute: f.execute, now: () => "2026-09-02T00:00:00.000Z" });
    expect(status).toMatchObject({ state: "ready", processReady: true, backend: "traceforge-linux-native", helper: { releaseManifest: "verified" },
      startupCleanup: { recoveredProcessTrees: 2, recoveredScratchTrees: 3 } });
    expect(JSON.stringify(await refreshLocalExecutionNodeHealth(status))).not.toContain(f.root);
  });

  it("fails closed for missing manifests, probe failures and unsupported hosts", async () => {
    const f = fixture(); rmSync(f.manifestPath);
    await expect(preflightLocalExecutionNode({ projectRoot: f.root, platform: "linux", architecture: "x64", env: f.env, execute: f.execute }))
      .resolves.toMatchObject({ state: "unavailable", reasonCode: "release_manifest_missing" });
    writeFileSync(f.manifestPath, JSON.stringify(createNativeHelperReleaseManifest({ platform: "linux", protocol: 2, bytes: Buffer.from("reviewed-helper") })));
    await expect(preflightLocalExecutionNode({ projectRoot: f.root, platform: "linux", architecture: "x64", env: f.env, execute: async () => { throw new Error("denied"); } }))
      .resolves.toMatchObject({ state: "unavailable", reasonCode: "native_probe_failed" });
    await expect(preflightLocalExecutionNode({ projectRoot: f.root, platform: "darwin", architecture: "arm64", env: {} }))
      .resolves.toMatchObject({ state: "unavailable", reasonCode: "platform_not_supported" });
  });

  it("detects helper replacement without rerunning destructive recovery", async () => {
    const f = fixture(); const preflight = await preflightLocalExecutionNode({ projectRoot: f.root, platform: "linux", architecture: "x64", env: f.env, execute: f.execute });
    writeFileSync(f.helper, "replaced-helper");
    await expect(refreshLocalExecutionNodeHealth(preflight, () => "2026-09-02T01:00:00.000Z"))
      .resolves.toMatchObject({ state: "degraded", processReady: false, reasonCode: "helper_measurement_changed" });
  });
});
