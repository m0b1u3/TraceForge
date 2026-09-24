import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const retiredPackages = ["extension", "mcp-poc-server", "tools", "reasoning-core"];
const retiredPaths = ["apps/web/index.html", "apps/web/renderer/workbench.tsx",
  "apps/web/renderer/preview-state.ts", "apps/web/renderer/preview-state.test.ts",
  "config/mcp.example.json", "scripts/retired-web.mjs",
  "apps/server/src/artifact-tools.ts", "apps/server/src/validation-workflow-snapshot.ts",
  "apps/server/src/observer-policy.ts", "apps/server/src/semantic-index.ts"];
const violations = [];
function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return ["node_modules", "dist", ".git"].includes(entry.name) ? [] : files(path);
    return /\.(?:[cm]?[jt]sx?|json|css|html)$/.test(entry.name) ? [path] : [];
  });
}
for (const path of retiredPaths) if (existsSync(resolve(root, path))) violations.push(path);
if (files(resolve(root, "apps/web/src")).length) violations.push("apps/web/src");
for (const name of retiredPackages) {
  if (files(resolve(root, "packages", name)).length) violations.push(`packages/${name}`);
}
for (const path of [resolve(root, "package.json"), ...["apps", "packages", "scenarios", "scripts"].flatMap(dir => files(resolve(root, dir)))]) {
  const source = readFileSync(path, "utf8");
  if (retiredPackages.some(name => new RegExp(`@traceforge/${name}(?=["'/\\s])`).test(source))) {
    violations.push(`retired dependency in ${relative(root, path)}`);
  }
}
if (violations.length) throw new Error(`Retired application code reintroduced:\n${violations.join("\n")}`);
console.log("Retired application source and dependency boundary verified.");
