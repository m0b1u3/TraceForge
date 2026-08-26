import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { parseWindowsSandboxHelperProbe } from "../packages/execution-node/src/windows-helper-contract.js";

if (process.platform !== "win32") {
  throw new Error("The TraceForge Windows sandbox helper must be built on Windows.");
}

const manifest = resolve("packages/windows-sandbox-helper/Cargo.toml");
const binary = resolve("packages/windows-sandbox-helper/target/release/traceforge-windows-sandbox.exe");
const bundled = resolve("packages/execution-node/native/win32-x64/traceforge-windows-sandbox.exe");
const result = spawnSync("cargo", ["build", "--release", "--manifest-path", manifest], {
  cwd: resolve("."),
  env: { ...process.env },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    "TraceForge Windows sandbox helper build failed. Install the MSVC C++ build tools and retry.",
  );
}

mkdirSync(dirname(bundled), { recursive: true });
copyFileSync(binary, bundled);
const probeResult = spawnSync(bundled, ["probe"], {
  cwd: resolve("."),
  encoding: "utf8",
  windowsHide: true,
});
if (probeResult.error) throw probeResult.error;
if (probeResult.status !== 0) throw new Error(`Windows sandbox helper probe failed: ${probeResult.stderr.trim()}`);
parseWindowsSandboxHelperProbe(probeResult.stdout);
console.log(`Bundled TraceForge Windows sandbox helper: ${bundled}`);
