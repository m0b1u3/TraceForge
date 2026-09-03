import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const supportedPlatforms = new Set(["win32", "darwin", "linux"]);
const requestedPlatform = process.argv[2] ?? process.platform;

if (!supportedPlatforms.has(requestedPlatform)) {
  throw new Error(`Unsupported desktop release platform: ${requestedPlatform}`);
}
if (requestedPlatform !== process.platform) {
  throw new Error(
    `Desktop installers must be built on their native host (requested ${requestedPlatform}, current ${process.platform}).`,
  );
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const run = (args: string[]) => {
  const result = spawnSync(pnpm, args, {
    cwd: resolve("."),
    env: { ...process.env, CI: "true" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
};

const target = requestedPlatform === "win32" ? "dist:win" : requestedPlatform === "darwin" ? "dist:mac" : "dist:linux";

if (requestedPlatform === "win32") run(["build:windows-sandbox"]);
if (requestedPlatform === "linux") run(["build:linux-sandbox"]);
run(["-r", "build"]);
run(["--filter", "@traceforge/desktop", target]);
run(["verify:desktop-release", "apps/desktop/release", requestedPlatform]);
