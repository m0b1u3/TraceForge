import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LINUX_SANDBOX_HELPER_PROTOCOL, parseLinuxSandboxHelperProbe } from "../packages/execution-node/src/linux-helper-contract.js";
import { createNativeHelperReleaseManifest } from "../packages/execution-node/src/native-helper-release.js";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The TraceForge linux-x64 sandbox helper must be built and tested on an x64 Linux host.");
}

const cgroupRoot = process.env.TRACEFORGE_LINUX_CGROUP_ROOT?.trim();
if (!cgroupRoot) {
  throw new Error("TRACEFORGE_LINUX_CGROUP_ROOT must name a delegated cgroup v2 directory.");
}

const manifest = resolve("packages/linux-sandbox-helper/Cargo.toml");
const binary = resolve("packages/linux-sandbox-helper/target/release/traceforge-linux-sandbox");
const bundled = resolve("packages/execution-node/native/linux-x64/traceforge-linux-sandbox");
const scratch = mkdtempSync(join(tmpdir(), "traceforge-linux-probe-"));

try {
  const tests = spawnSync("cargo", ["test", "--locked", "--manifest-path", manifest], {
    cwd: resolve("."), env: { ...process.env }, stdio: "inherit",
  });
  if (tests.error) throw tests.error;
  if (tests.status !== 0) throw new Error("Linux sandbox helper tests failed; refusing to bundle.");

  const build = spawnSync("cargo", ["build", "--locked", "--release", "--manifest-path", manifest], {
    cwd: resolve("."), env: { ...process.env }, stdio: "inherit",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error("Linux sandbox helper release build failed; refusing to bundle.");

  mkdirSync(dirname(bundled), { recursive: true });
  copyFileSync(binary, bundled);
  chmodSync(bundled, 0o755);
  const probe = spawnSync(bundled, [
    "probe", "--cgroup-root", cgroupRoot, "--scratch-root", scratch,
  ], { cwd: resolve("."), encoding: "utf8" });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(`Linux sandbox helper probe failed: ${probe.stderr.trim()}`);
  parseLinuxSandboxHelperProbe(probe.stdout);
  const acceptance = spawnSync(process.execPath, [resolve("scripts/verify-linux-sandbox-native.mjs")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      TRACEFORGE_LINUX_SANDBOX_HELPER: bundled,
      TRACEFORGE_LINUX_CGROUP_ROOT: cgroupRoot,
      TRACEFORGE_LINUX_SCRATCH_ROOT: scratch,
    },
    stdio: "inherit",
  });
  if (acceptance.error) throw acceptance.error;
  if (acceptance.status !== 0) {
    throw new Error("Linux sandbox native acceptance failed; refusing to bundle.");
  }
  const releaseManifest = createNativeHelperReleaseManifest({
    platform: "linux", protocol: LINUX_SANDBOX_HELPER_PROTOCOL, bytes: readFileSync(bundled),
  });
  const manifestPath = resolve(dirname(bundled), "release.json"), temporaryManifest = `${manifestPath}.tmp`;
  writeFileSync(temporaryManifest, `${JSON.stringify(releaseManifest, null, 2)}\n`, { mode: 0o644 });
  renameSync(temporaryManifest, manifestPath);
  console.log(`Bundled TraceForge Linux sandbox helper: ${bundled}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
