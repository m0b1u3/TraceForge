import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createNativeHelperReleaseManifest } from "../packages/execution-node/src/native-helper-release.js";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Build the macOS helper on Apple Silicon");
const root = resolve("packages/execution-node/native/darwin-arm64");
await mkdir(root, { recursive: true });
const executable = join(root, "traceforge-macos-sandbox");
const result = spawnSync("/usr/bin/clang", ["-arch", "arm64", "-O2", "-Wall", "-Wextra", "-Werror",
  resolve("packages/execution-node/native-src/macos-owned-process.c"), "-o", executable], { stdio: "inherit" });
if (result.error || result.status !== 0) throw result.error ?? new Error("macOS helper build failed");
await writeFile(join(root, "release.json"), JSON.stringify(createNativeHelperReleaseManifest({ platform: "darwin", protocol: 1,
  bytes: await readFile(executable) }), null, 2) + "\n");
console.log(`Built macOS arm64 helper and integrity inventory: ${root}. This is not signing or notarization proof.`);
