import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseWindowsSandboxHelperProbe } from "../packages/execution-node/src/windows-helper-contract.js";

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
if (platform === "win32") {
  const blockmap = `${artifactPath}.blockmap`;
  if (!existsSync(blockmap) || statSync(blockmap).size === 0) throw new Error(`missing incremental update blockmap for ${artifactName}`);
  const helper = resolve(releaseDirectory, "win-unpacked/resources/native/win32-x64/traceforge-windows-sandbox.exe");
  if (!existsSync(helper) || statSync(helper).size === 0) throw new Error("Windows desktop release is missing the sandbox helper");
  const result = spawnSync(helper, ["probe"], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`packaged Windows sandbox helper probe failed: ${result.stderr.trim()}`);
  parseWindowsSandboxHelperProbe(result.stdout);
}
console.log(`Verified ${basename(artifactPath)} (${statSync(artifactPath).size} bytes), version ${version}, sha512 and update metadata.`);
