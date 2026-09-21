import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
const root = resolve(import.meta.dirname, "..");
const paths = ["apps/server/src/workspace-network-host.ts", "apps/server/src/desktop-mcp-session.ts", "packages/resource-runtime/src/public-fetch.ts"];
const visit = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(directory, entry.name);
  if (entry.isSymbolicLink() || ["node_modules", "dist"].includes(entry.name)) return [];
  return entry.isDirectory() ? visit(path) : /\.m?ts$/.test(entry.name) && path.includes("runtime-src") ? [relative(root, path)] : [];
});
paths.push(...visit(resolve(root, "scenarios")));
const violations = paths.filter(path => {
  const text = readFileSync(resolve(root, path), "utf8");
  return /\bfetch\s*\(|from\s*["'](?:node:)?(?:https?|net|dns)(?:\/promises)?["']|import\s*\(\s*["'](?:node:)?(?:https?|net|dns)/.test(text);
});
const broker = readFileSync(resolve(root, "packages/execution-node/src/network-broker.ts"), "utf8");
if (/\bfetch\s*\(/.test(broker) || !broker.includes("resolveNetworkDestination") || !broker.includes("requestPinnedHttp")) violations.push("execution-node broker bypass");
if (violations.length) { console.error("Network boundary violation:", violations.join(", ")); process.exitCode = 1; }
else console.log(`Network boundary verified for ${paths.length} Scenario/Host/resource files. Static regression guard; not an OS network firewall.`);
