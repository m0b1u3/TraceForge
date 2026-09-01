import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const violations = [];

function sourceFiles(root) {
  const absolute = resolve(projectRoot, root);
  return readdirSync(absolute).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) return [];
    const path = resolve(absolute, entry);
    if (statSync(path).isDirectory()) return sourceFiles(relative(projectRoot, path));
    return /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

const forbiddenImports = [
  /(?:from\s+|import\s*\()\s*["']@traceforge\/scenario-(?!sdk(?:["'/]))/,
  /(?:from\s+|import\s*\()\s*["'][^"']*scenarios\//,
  /(?:from\s+|import\s*\()\s*["'][^"']*apps\//,
];

const foundationSources = [
  ...sourceFiles("packages").filter((path) => path.includes("/src/") && !/(?:\.test|\.integration\.test)\.[cm]?[jt]sx?$/.test(path)),
  ...sourceFiles("apps/server/src").filter((path) =>
    !path.endsWith("/main.ts") && !path.includes("/test-fixtures/") && !/(?:\.test|\.integration\.test)\.[cm]?[jt]sx?$/.test(path)),
];

for (const path of foundationSources) {
  const source = readFileSync(path, "utf8");
  for (const pattern of forbiddenImports) {
    if (pattern.test(source)) violations.push(`${relative(projectRoot, path)} imports an application or concrete Scenario package`);
  }
}

const packageFiles = readdirSync(resolve(projectRoot, "packages"))
  .map((entry) => resolve(projectRoot, "packages", entry, "package.json"))
  .filter((path) => {
    try { return statSync(path).isFile(); }
    catch { return false; }
  });

const workspacePackages = new Map(packageFiles.map((packageFile) => {
  const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
  return [manifest.name, { packageFile, manifest }];
}));

for (const { packageFile, manifest } of workspacePackages.values()) {
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@traceforge/scenario-") && dependency !== "@traceforge/scenario-sdk") {
      violations.push(`${relative(projectRoot, packageFile)} depends on concrete Scenario package ${dependency}`);
    }
  }
}

const dependencyGraph = new Map([...workspacePackages].map(([name, { manifest }]) => [
  name,
  Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })
    .filter((dependency) => workspacePackages.has(dependency)),
]));
const visited = new Set();
const active = [];
const activeSet = new Set();

function visitPackage(name) {
  if (activeSet.has(name)) {
    const cycleStart = active.indexOf(name);
    violations.push(`workspace dependency cycle: ${[...active.slice(cycleStart), name].join(" -> ")}`);
    return;
  }
  if (visited.has(name)) return;
  active.push(name);
  activeSet.add(name);
  for (const dependency of dependencyGraph.get(name) ?? []) visitPackage(dependency);
  active.pop();
  activeSet.delete(name);
  visited.add(name);
}

for (const name of workspacePackages.keys()) visitPackage(name);

const scenarioSdkSources = sourceFiles("packages/scenario-sdk/src")
  .filter((path) => !/(?:\.test|\.integration\.test)\.[cm]?[jt]sx?$/.test(path));
for (const path of scenarioSdkSources) {
  const source = readFileSync(path, "utf8");
  if (/\b(?:ScenarioSessionPort|ScenarioTrafficPort|ExecutionCookie|ExecutionNode|BrokeredHttp|BrowserObservation)\b/.test(source)) {
    violations.push(`${relative(projectRoot, path)} exposes a concrete Web/transport host contract`);
  }
}

for (const path of sourceFiles("packages/agent-runtime/src")) {
  if (/(?:\.test|\.integration\.test)\.[cm]?[jt]sx?$/.test(path)) continue;
  const source = readFileSync(path, "utf8");
  if (/@traceforge\/(?:worker-runtime|scenario-|execution-node)|apps\/|scenarios\//.test(source)) {
    violations.push(`${relative(projectRoot, path)} reverses the Agent Runtime dependency boundary`);
  }
}

const workerRuntimeSource = readFileSync(resolve(projectRoot, "packages/worker-runtime/src/runtime.ts"), "utf8");
if (!/class WorkerHost\b/.test(workerRuntimeSource) || !/new AgentHarness\(\)\.openSession/.test(workerRuntimeSource)) {
  violations.push("worker-runtime must delegate Agent turn ownership to AgentHarness while exposing WorkerHost");
}
if (/\bLeaseWorkerRuntime\b|\bLeaseWorkerOptions\b/.test(workerRuntimeSource)) {
  violations.push("worker-runtime must not restore the retired lease-era public runtime names");
}

const scenarioSdkSource = scenarioSdkSources.map((path) => readFileSync(path, "utf8")).join("\n");
if (!/interface ScenarioArtifactPort\b/.test(scenarioSdkSource)
  || !/interface ScenarioStatePort\b/.test(scenarioSdkSource)
  || !/artifacts:\s*ScenarioArtifactPort/.test(scenarioSdkSource)
  || !/state:\s*ScenarioStatePort/.test(scenarioSdkSource)) {
  violations.push("scenario-sdk must retain generic Artifact and State host capabilities");
}

if (violations.length) {
  throw new Error(`Foundation boundary violations:\n${[...new Set(violations)].map((item) => `- ${item}`).join("\n")}`);
}

console.log(`Foundation boundary verified across ${foundationSources.length} production source files.`);
