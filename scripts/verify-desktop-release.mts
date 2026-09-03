import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { LINUX_SANDBOX_HELPER_PROTOCOL, parseLinuxSandboxHelperProbe } from "../packages/execution-node/src/linux-helper-contract.js";
import { parseWindowsSandboxHelperProbe, WINDOWS_SANDBOX_HELPER_PROTOCOL } from "../packages/execution-node/src/windows-helper-contract.js";
import { verifyNativeHelperRelease } from "../packages/execution-node/src/native-helper-release.js";

const releaseDirectory = resolve(process.argv[2] ?? "apps/desktop/release");
const platform = process.argv[3] ?? process.platform;
const packageJson = JSON.parse(readFileSync(resolve("apps/desktop/package.json"), "utf8")) as { version: string };
const metadataName = platform === "darwin" ? "latest-mac.yml" : platform === "linux" ? "latest-linux.yml" : "latest.yml";
const metadataPath = resolve(releaseDirectory, metadataName);
if (!existsSync(metadataPath)) throw new Error(`missing update metadata ${metadataName}`);
const metadata = readFileSync(metadataPath, "utf8");
const version = /^version:\s*['"]?([^'"\s]+)['"]?/m.exec(metadata)?.[1];
if (version !== packageJson.version) throw new Error(`metadata version ${version ?? "missing"} does not match package ${packageJson.version}`);
const artifactName = /^path:\s*['"]?([^'"\r\n]+)['"]?/m.exec(metadata)?.[1]?.trim();
const expectedSha512 = /^sha512:\s*([^\s]+)$/m.exec(metadata)?.[1];
if (!artifactName || !expectedSha512) throw new Error(`${metadataName} is missing path or sha512`);
const artifactPath = resolve(releaseDirectory, artifactName);
if (!existsSync(artifactPath) || statSync(artifactPath).size < 1_000_000) throw new Error(`desktop artifact is missing or implausibly small: ${artifactName}`);
const actualSha512 = createHash("sha512").update(readFileSync(artifactPath)).digest("base64");
if (actualSha512 !== expectedSha512) throw new Error(`sha512 mismatch for ${artifactName}`);
function verifyHelperManifest(helper: string, expectedPlatform: "linux" | "windows", protocol: number): void {
  const manifestPath = resolve(helper, "../release.json");
  if (!existsSync(manifestPath)) throw new Error(`Packaged ${expectedPlatform} sandbox helper release manifest is missing`);
  if (!statSync(manifestPath).isFile() || statSync(manifestPath).size > 16 * 1024) throw new Error(`Packaged ${expectedPlatform} helper release manifest is invalid`);
  verifyNativeHelperRelease(JSON.parse(readFileSync(manifestPath, "utf8")), {
    platform: expectedPlatform,
    architecture: "x64",
    backend: expectedPlatform === "linux" ? "traceforge-linux-native" : "traceforge-windows-native",
    executable: basename(helper), protocol, bytes: readFileSync(helper),
  });
}
if (platform === "win32") {
  const blockmap = `${artifactPath}.blockmap`;
  if (!existsSync(blockmap) || statSync(blockmap).size === 0) throw new Error(`missing incremental update blockmap for ${artifactName}`);
  const helper = resolve(releaseDirectory, "win-unpacked/resources/native/win32-x64/traceforge-windows-sandbox.exe");
  if (!existsSync(helper) || statSync(helper).size === 0) throw new Error("Windows desktop release is missing the sandbox helper");
  verifyHelperManifest(helper, "windows", WINDOWS_SANDBOX_HELPER_PROTOCOL);
  const result = spawnSync(helper, ["probe"], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`packaged Windows sandbox helper probe failed: ${result.stderr.trim()}`);
  parseWindowsSandboxHelperProbe(result.stdout);
}
if (platform === "linux") {
  const helper = resolve(releaseDirectory, "linux-unpacked/resources/native/linux-x64/traceforge-linux-sandbox");
  if (!existsSync(helper) || statSync(helper).size === 0) throw new Error("Linux desktop release is missing the sandbox helper");
  if ((statSync(helper).mode & 0o111) === 0) throw new Error("Packaged Linux sandbox helper is not executable");
  verifyHelperManifest(helper, "linux", LINUX_SANDBOX_HELPER_PROTOCOL);
  const cgroupRoot = process.env.TRACEFORGE_LINUX_CGROUP_ROOT?.trim();
  if (!cgroupRoot) throw new Error("TRACEFORGE_LINUX_CGROUP_ROOT is required to verify the packaged Linux helper");
  const scratch = mkdtempSync(join(tmpdir(), "traceforge-packaged-linux-probe-"));
  try {
    const result = spawnSync(helper, ["probe", "--cgroup-root", cgroupRoot, "--scratch-root", scratch], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`packaged Linux sandbox helper probe failed: ${result.stderr.trim()}`);
    parseLinuxSandboxHelperProbe(result.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
console.log(`Verified ${basename(artifactPath)} (${statSync(artifactPath).size} bytes), version ${version}, sha512 and update metadata.`);
