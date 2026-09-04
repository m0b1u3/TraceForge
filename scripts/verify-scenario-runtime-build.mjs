import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const packageRoot = resolve(projectRoot, process.argv[2] ?? "");
if (!packageRoot || !statSync(packageRoot).isDirectory()) throw new Error("Scenario package root is required");
const sourceRoot = join(packageRoot, "runtime-src"), runtimeRoot = join(packageRoot, "runtime");
const sourceFiles = files(sourceRoot, ".mts"), runtimeFiles = files(runtimeRoot, ".mjs");
if (sourceFiles.length < 5 || !sourceFiles.includes("main.mts")) throw new Error("Scenario runtime must be split into reviewed TypeScript modules");
if (!runtimeFiles.includes("main.mjs") || runtimeFiles.length !== sourceFiles.length
  || runtimeFiles.some((path) => !sourceFiles.includes(path.replace(/\.mjs$/, ".mts")))) {
  throw new Error("Scenario runtime output does not exactly match its TypeScript module set");
}

const reachable = new Set(["main.mjs"]), pending = ["main.mjs"];
while (pending.length) {
  const current = pending.pop(), body = readFileSync(join(runtimeRoot, current), "utf8");
  if (body.includes("runtime-src") || body.includes("apps/server") || body.includes("node_modules")) {
    throw new Error(`Scenario runtime contains a forbidden build- or host-relative import: ${current}`);
  }
  for (const match of body.matchAll(/from\s+["']\.\/([^"']+\.mjs)["']/g)) {
    const dependency = match[1];
    if (!runtimeFiles.includes(dependency)) throw new Error(`Scenario runtime dependency is missing: ${dependency}`);
    if (!reachable.has(dependency)) { reachable.add(dependency); pending.push(dependency); }
  }
}
if (reachable.size !== runtimeFiles.length) throw new Error("Scenario runtime contains an unreachable generated module");

const temporary = mkdtempSync(join(tmpdir(), `traceforge-${basename(packageRoot)}-runtime-`));
try {
  const compiler = resolve(projectRoot, "node_modules/typescript/bin/tsc");
  const result = spawnSync(process.execPath, [compiler, "-p", join(packageRoot, "tsconfig.runtime.json"), "--outDir", temporary], {
    cwd: projectRoot, encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Scenario runtime reproducibility compile failed: ${result.stdout}\n${result.stderr}`);
  for (const path of runtimeFiles) {
    const published = readFileSync(join(runtimeRoot, path)), rebuilt = readFileSync(join(temporary, path));
    if (!published.equals(rebuilt)) throw new Error(`Scenario runtime build is not reproducible: ${path}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

const digest = createHash("sha256");
for (const path of runtimeFiles) digest.update(path).update("\0").update(readFileSync(join(runtimeRoot, path)));
console.log(`Verified ${runtimeFiles.length} reproducible Scenario runtime modules (${digest.digest("hex")}).`);

function files(root, extension) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) throw new Error(`Nested Scenario runtime directories are not supported: ${entry.name}`);
    return entry.isFile() && entry.name.endsWith(extension) ? [relative(root, join(root, entry.name))] : [];
  }).sort();
}
