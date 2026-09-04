import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const entry = resolve(projectRoot, "packages/browser-runtime/src/controller-main.ts");
const esbuild = resolve(projectRoot, "node_modules/.bin/esbuild");
const temporary = mkdtempSync(join(tmpdir(), "traceforge-browser-controller-"));

try {
  const outputs = ["first.mjs", "second.mjs"].map((name) => {
    const output = join(temporary, name);
    execFileSync(esbuild, [entry, "--bundle", "--platform=node", "--target=node22", "--format=esm", `--outfile=${output}`], {
      cwd: projectRoot,
      stdio: "pipe",
    });
    return readFileSync(output);
  });
  if (!outputs[0].equals(outputs[1])) throw new Error("Browser Controller bundle build is not reproducible");
  const text = outputs[0].toString("utf8");
  if (!text.startsWith("#!/usr/bin/env node\n") || outputs[0].length < 1024 || outputs[0].length > 1024 * 1024) {
    throw new Error("Browser Controller bundle shape is invalid");
  }
  if (/from\s+["']\.\.?\//.test(text) || /@traceforge\//.test(text)) {
    throw new Error("Browser Controller bundle retained an unreviewed local runtime dependency");
  }
  console.log(`Browser Controller reproducible bundle verified (${outputs[0].length} bytes).`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
