// Electron needs the workspace TypeScript loader before the verification module
// resolves its .js specifiers to .ts source files.
import { register } from "../apps/server/dist/development-loader.js";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

if (process.env.TRACEFORGE_EMBEDDED_VISUAL === "1") {
  await mkdir("output", { recursive: true });
  await build({ entryPoints: ["scripts/fixtures/embedded-browser-review.tsx"], outfile: "output/embedded-browser-review.js",
    bundle: true, platform: "browser", format: "iife", nodePaths: ["apps/web/node_modules"] });
  await build({ entryPoints: ["scripts/fixtures/embedded-browser-review-preload.cts"], outfile: "output/embedded-browser-review-preload.cjs",
    bundle: true, platform: "node", format: "cjs", external: ["electron"] });
}

register();
await import("./verify-embedded-browser.mts");
