import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const violations = [];

const serverCompositionSource = readFileSync(resolve(projectRoot, "apps/server/src/main.ts"), "utf8");
const applicationRoutesSource = readFileSync(resolve(projectRoot, "apps/server/src/routes.ts"), "utf8");
if (/\b(?:McpManager|loadMcpConfig|connectAll)\b/.test(serverCompositionSource)
  || /\/api\/mcp\/tools/.test(applicationRoutesSource)) {
  violations.push("Server composition must not launch MCP directly or expose the retired MCP bypass API");
}
if (/reveal-key|revealApiKey/.test(applicationRoutesSource)) {
  violations.push("Application routes must never reveal persisted model credentials");
}
const webScenarioRoot = resolve(projectRoot, "scenarios/web-blackbox/src");
for (const retired of ["package.ts", "tools.ts", "ports.ts"]) {
  try { if (statSync(resolve(webScenarioRoot, retired)).isFile()) violations.push(`Web Scenario must not restore retired in-process ${retired}`); }
  catch { /* expected: the descriptor/process package is the sole production implementation */ }
}
const webScenarioProduction = sourceFiles("scenarios/web-blackbox/src")
  .filter((path) => !/(?:\.test|\.integration\.test)\.[cm]?[jt]sx?$/.test(path))
  .map((path) => readFileSync(path, "utf8")).join("\n");
if (/from\s+["']playwright["']|\bcreateToolSources\b|\bScenarioBrowserObserveTool\b/.test(webScenarioProduction)) {
  violations.push("Web Scenario production source must remain descriptor/process-only without direct browser or in-process tool factories");
}
const webRuntimeSources = sourceFiles("scenarios/web-blackbox/runtime-src");
const webRuntimeOutputs = sourceFiles("scenarios/web-blackbox/runtime");
const webRuntimeBuildSource = readFileSync(resolve(projectRoot, "scripts/verify-scenario-runtime-build.mjs"), "utf8");
const scenarioPackageBuildSource = readFileSync(resolve(projectRoot, "scripts/package-scenario.mts"), "utf8");
const serverRunContextPolicySource = readFileSync(resolve(projectRoot, "apps/server/src/run-context-policy.ts"), "utf8");
const cognitiveLineageSource = readFileSync(resolve(projectRoot, "packages/cognitive-runtime/src/lineage.ts"), "utf8");
const serverPlannerAdapterSource = readFileSync(resolve(projectRoot, "apps/server/src/run-planner.ts"), "utf8");
const serverObserverAdapterSource = readFileSync(resolve(projectRoot, "apps/server/src/run-observer.ts"), "utf8");
const cognitivePlanningSource = readFileSync(resolve(projectRoot, "packages/cognitive-runtime/src/run-planning.ts"), "utf8");
const cognitiveObservationSource = readFileSync(resolve(projectRoot, "packages/cognitive-runtime/src/run-observation.ts"), "utf8");
const cognitiveWorkerModelSource = readFileSync(resolve(projectRoot, "packages/cognitive-runtime/src/structured-worker-model.ts"), "utf8");
const browserRuntimeSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/index.ts"), "utf8");
const browserControllerSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/execution-node-controller.ts"), "utf8");
const chromiumCdpAdapterSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/chromium-cdp-adapter.ts"), "utf8");
const browserControllerProcessSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/controller-process-runtime.ts"), "utf8");
const chromiumPipeTransportSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/chromium-pipe-transport.ts"), "utf8");
const browserRuntimeReleaseSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/browser-runtime-release.ts"), "utf8");
const browserRuntimeTreeSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/browser-runtime-tree.ts"), "utf8");
const browserRuntimeReleaseBuilderSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/browser-runtime-release-builder.ts"), "utf8");
const browserRuntimeSourceLockSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/browser-runtime-source-lock.ts"), "utf8");
const browserRuntimeArchiveSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/browser-runtime-archive.ts"), "utf8");
const browserRuntimeSourceReviewSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/browser-runtime-source-review.ts"), "utf8");
const browserRuntimeBuildAttestationSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/browser-runtime-build-attestation.ts"), "utf8");
const chromiumControllerBootstrapSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/chromium-controller-bootstrap.ts"), "utf8");
const chromiumPageRuntimeSource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/chromium-page-runtime.ts"), "utf8");
const browserControllerEntrySource = readFileSync(resolve(projectRoot, "packages/browser-runtime/src/node-controller-entry.ts"), "utf8");
const browserControllerBundleVerificationSource = readFileSync(resolve(projectRoot, "scripts/verify-browser-controller-build.mjs"), "utf8");
const embeddedWorkersSource = readFileSync(resolve(projectRoot, "apps/server/src/embedded-workers.ts"), "utf8");
if (webRuntimeSources.length < 5 || webRuntimeOutputs.length !== webRuntimeSources.length
  || !webRuntimeSources.some((path) => path.endsWith("/main.mts"))
  || !webRuntimeBuildSource.includes("build is not reproducible")
  || !scenarioPackageBuildSource.includes('role:path===entry?"entry"')
  || !scenarioPackageBuildSource.includes('"dependency"')) {
  violations.push("Web Scenario runtime must remain modular TypeScript with reproducible generated modules included in signed material");
}
try {
  if (statSync(resolve(projectRoot, "apps/server/src/run-context-assembly.ts")).isFile()) {
    violations.push("Generic Run context assembly must not return to the Server package");
  }
} catch { /* expected: assembly is owned by cognitive-runtime */ }
if (!/projectRunContextLineage/.test(cognitiveLineageSource)
  || !/assembleRunContext/.test(cognitiveLineageSource)
  || !/projectRunContextLineage/.test(serverRunContextPolicySource)) {
  violations.push("Cognitive context projection and assembly must remain in the reusable Cognitive Runtime");
}
if (!/export class RunPlannerSupervisor/.test(cognitivePlanningSource)
  || !/export class StructuredRunPlannerModel/.test(cognitivePlanningSource)
  || !/export class RunObserverSupervisor/.test(cognitiveObservationSource)
  || !/export class StructuredRunObserverModel/.test(cognitiveObservationSource)
  || /better-sqlite3|fastify/.test(`${cognitivePlanningSource}\n${cognitiveObservationSource}`)
  || /class RunPlannerSupervisor|class StructuredRunPlannerModel|CognitiveLoopScheduler|You are the strategic Planner/.test(serverPlannerAdapterSource)
  || /class RunObserverSupervisor|class StructuredRunObserverModel|CognitiveLoopScheduler|You are the independent Run Observer/.test(serverObserverAdapterSource)) {
  violations.push("Planner and Observer decision/model supervision must remain package-owned while Server files stay transport/persistence adapters");
}
try {
  if (statSync(resolve(projectRoot, "apps/server/src/structured-worker-model.ts")).isFile()) {
    violations.push("Structured Worker cognition must not return to the Server package");
  }
} catch { /* expected: Worker model is owned by cognitive-runtime */ }
if (!/export class StructuredWorkerModel/.test(cognitiveWorkerModelSource)
  || !/parseStructuredWorkerDecision/.test(cognitiveWorkerModelSource)
  || /better-sqlite3|fastify/.test(cognitiveWorkerModelSource)
  || !/StructuredWorkerModel\s*}\s*from\s*"@traceforge\/cognitive-runtime"/.test(embeddedWorkersSource)) {
  violations.push("Structured Worker prompt, decision and model supervision must remain in Cognitive Runtime with Server using the package export");
}
if (!/export class BrokeredBrowserRuntime/.test(browserRuntimeSource)
  || !/processPermissions\.network = "deny"/.test(browserRuntimeSource)
  || !/hostPermissions\.network = "brokered"/.test(browserRuntimeSource)
  || !/requestInterception: "before_network"/.test(browserRuntimeSource)
  || !/serviceWorkers: "disabled"/.test(browserRuntimeSource)
  || !/websocket_streaming_unavailable/.test(browserRuntimeSource)
  || !/executionNode\.requestHttp/.test(browserRuntimeSource)
  || !/class ExecutionNodeBrowserController/.test(browserControllerSource)
  || !/waitProcessEvents/.test(browserControllerSource)
  || !/writeProcessInput/.test(browserControllerSource)
  || !/measured identity does not match/.test(browserControllerSource)
  || !/event stream lost protocol bytes/.test(browserControllerSource)
  || !/Target\.setAutoAttach/.test(chromiumCdpAdapterSource)
  || !/waitForDebuggerOnStart:\s*true/.test(chromiumCdpAdapterSource)
  || !/Browser\.setDownloadBehavior/.test(chromiumCdpAdapterSource)
  || !/Fetch\.fulfillRequest/.test(chromiumCdpAdapterSource)
  || !/Target\.closeTarget/.test(chromiumCdpAdapterSource)
  || !/class BrowserControllerProcessRuntime/.test(browserControllerProcessSource)
  || !/request_result/.test(browserControllerProcessSource)
  || !/class ChromiumPipeTransport/.test(chromiumPipeTransportSource)
  || !/--remote-debugging-pipe/.test(chromiumPipeTransportSource)
  || !/stdio:\s*\["ignore",\s*"ignore",\s*"pipe",\s*"pipe",\s*"pipe"\]/.test(chromiumPipeTransportSource)
  || !/browserSha256/.test(chromiumPipeTransportSource)
  || !/Browser\.getVersion/.test(chromiumPipeTransportSource)
  || !/--no-sandbox/.test(chromiumPipeTransportSource)
  || !/--proxy-server/.test(chromiumPipeTransportSource)
  || !/BROWSER_RUNTIME_RELEASE_PROFILE/.test(browserRuntimeReleaseSource)
  || !/verifyInstalledBrowserRuntimeRelease/.test(browserRuntimeReleaseSource)
  || !/controllerSha256/.test(browserRuntimeReleaseSource)
  || !/browserSha256/.test(browserRuntimeReleaseSource)
  || !/measureBrowserRuntimeTree/.test(browserRuntimeReleaseSource)
  || !/stableFileSha256/.test(browserRuntimeTreeSource)
  || !/contains an absolute symbolic link/.test(browserRuntimeTreeSource)
  || !/tree entry limit exceeded/.test(browserRuntimeTreeSource)
  || !/assembleBrowserRuntimeRelease/.test(browserRuntimeReleaseBuilderSource)
  || !/extractBrowserRuntimeSourceArchive/.test(browserRuntimeReleaseBuilderSource)
  || !/release destination already exists/.test(browserRuntimeReleaseBuilderSource)
  || !/BROWSER_RUNTIME_SOURCE_LOCK_PROFILE/.test(browserRuntimeSourceLockSource)
  || !/securityReviewRef/.test(browserRuntimeSourceLockSource)
  || !/licenseReviewRef/.test(browserRuntimeSourceLockSource)
  || !/buildAttestationSha256/.test(browserRuntimeSourceLockSource)
  || !/verifyBrowserRuntimeSourceArchiveHandle/.test(browserRuntimeSourceLockSource)
  || !/BROWSER_RUNTIME_SOURCE_REVIEW_PROFILE/.test(browserRuntimeSourceReviewSource)
  || !/BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE/.test(browserRuntimeSourceReviewSource)
  || !/asymmetricKeyType !== "ed25519"/.test(browserRuntimeSourceReviewSource)
  || !/source review or authority is not currently valid/.test(browserRuntimeSourceReviewSource)
  || !/source review signature verification failed/.test(browserRuntimeSourceReviewSource)
  || !/BROWSER_RUNTIME_BUILD_ATTESTATION_PROFILE/.test(browserRuntimeBuildAttestationSource)
  || !/chromium\.googlesource\.com\/chromium\/src\.git/.test(browserRuntimeBuildAttestationSource)
  || !/requires at least two bounded reproductions/.test(browserRuntimeBuildAttestationSource)
  || !/buildEnvironmentSha256/.test(browserRuntimeBuildAttestationSource)
  || !/platform signature does not match/.test(browserRuntimeBuildAttestationSource)
  || !/lock\.buildAttestationSha256 !== attestationSha256/.test(browserRuntimeBuildAttestationSource)
  || !/browser tree does not match its build attestation/.test(browserRuntimeReleaseBuilderSource)
  || !/archive contains an encrypted entry/.test(browserRuntimeArchiveSource)
  || !/archive path escapes its extraction root/.test(browserRuntimeArchiveSource)
  || !/places content below a symbolic link/.test(browserRuntimeArchiveSource)
  || !/startChromiumController/.test(chromiumControllerBootstrapSource)
  || !/ChromiumPipeTransport\.launch/.test(chromiumControllerBootstrapSource)
  || !/class ChromiumPageRuntime/.test(chromiumPageRuntimeSource)
  || !/Accessibility\.getFullAXTree/.test(chromiumPageRuntimeSource)
  || !/Page\.captureScreenshot/.test(chromiumPageRuntimeSource)
  || !/backendNodeId/.test(chromiumPageRuntimeSource)
  || !/sensitiveValues:\s*"omitted"/.test(chromiumPageRuntimeSource)
  || !/DOM\.getBoxModel/.test(chromiumPageRuntimeSource)
  || !/Input\.insertText/.test(chromiumPageRuntimeSource)
  || !/was not issued by the latest DOM observation/.test(chromiumPageRuntimeSource)
  || !/beginTakeover/.test(chromiumPageRuntimeSource)
  || !/observeManual/.test(chromiumPageRuntimeSource)
  || !/stale control generation/.test(chromiumPageRuntimeSource)
  || !/runChromiumControllerProcess/.test(browserControllerEntrySource)
  || !/readBoundedJson\(input\.releaseManifestPath,[^\n]+"release manifest"\)/.test(browserControllerEntrySource)
  || !/readBoundedJson\(input\.sourceLockPath,[^\n]+"source lock"\)/.test(browserControllerEntrySource)
  || !/readBoundedJson\(input\.sourceReviewPath,[^\n]+"source review"\)/.test(browserControllerEntrySource)
  || !/readBoundedJson\(input\.sourceAuthorityPath,[^\n]+"source authority"\)/.test(browserControllerEntrySource)
  || !/readBoundedJson\(input\.buildAttestationPath,[^\n]+"build attestation"\)/.test(browserControllerEntrySource)
  || !/build is not reproducible/.test(browserControllerBundleVerificationSource)
  || !/retained an unreviewed local runtime dependency/.test(browserControllerBundleVerificationSource)
  || !/command === "observe"/.test(browserControllerProcessSource)
  || !/command === "begin_takeover"/.test(browserControllerProcessSource)
  || !/command === "manual_observe"/.test(browserControllerProcessSource)
  || /from\s+["'][^"']*(?:apps|scenarios)\//.test(
    `${browserRuntimeSource}\n${browserControllerSource}\n${chromiumCdpAdapterSource}\n${browserControllerProcessSource}\n${chromiumPipeTransportSource}\n${browserRuntimeReleaseSource}\n${browserRuntimeTreeSource}\n${browserRuntimeReleaseBuilderSource}\n${browserRuntimeSourceLockSource}\n${browserRuntimeSourceReviewSource}\n${browserRuntimeBuildAttestationSource}\n${browserRuntimeArchiveSource}\n${chromiumControllerBootstrapSource}\n${chromiumPageRuntimeSource}\n${browserControllerEntrySource}`)) {
  violations.push("Browser Runtime must retain OS-denied browser networking, pre-network interception and host-side brokered requests without Scenario coupling");
}

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
  ...sourceFiles("packages").filter((path) => path.includes("/src/") && !path.includes("/test-fixtures/") && !/(?:\.test|\.integration\.test)\.[cm]?[jt]sx?$/.test(path)),
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
const agentRuntimeSource = sourceFiles("packages/agent-runtime/src")
  .filter((path) => !/(?:\.test|\.integration\.test)\.[cm]?[jt]sx?$/.test(path))
  .map((path) => readFileSync(path, "utf8")).join("\n");
if (!/interface AgentExecutionJournal\b/.test(agentRuntimeSource)
  || !/AGENT_EXECUTION_JOURNAL_VERSION\s*=\s*1/.test(agentRuntimeSource)
  || !/recordAgentJournalTerminal/.test(agentRuntimeSource)) {
  violations.push("agent-runtime must retain the versioned Execution Journal and terminal-state protocol");
}
const checkpointSource = readFileSync(resolve(projectRoot, "packages/worker-runtime/src/checkpoint-store.ts"), "utf8");
if (!/version === 3/.test(checkpointSource) || !/upgradeWorkerCheckpoint/.test(checkpointSource)
  || !/ambiguous cognitive state/.test(checkpointSource)
  || !/class AgentJournalCheckpointAdapter\b/.test(readFileSync(resolve(projectRoot, "packages/worker-runtime/src/agent-journal-checkpoint.ts"), "utf8"))) {
  violations.push("worker-runtime must retain v3 Host checkpoints and the Agent Journal persistence adapter");
}
if (/checkpoint\.(?:turn|transcript|steering|completedInvocationIds|consecutiveFailures)\b/.test(workerRuntimeSource)) {
  violations.push("WorkerHost must not restore legacy cognitive fields outside the Agent Journal");
}

const scenarioSdkSource = scenarioSdkSources.map((path) => readFileSync(path, "utf8")).join("\n");
if (!/interface ScenarioArtifactPort\b/.test(scenarioSdkSource)
  || !/interface ScenarioStatePort\b/.test(scenarioSdkSource)
  || !/artifacts:\s*ScenarioArtifactPort/.test(scenarioSdkSource)
  || !/state:\s*ScenarioStatePort/.test(scenarioSdkSource)) {
  violations.push("scenario-sdk must retain generic Artifact and State host capabilities");
}
const scenarioProcessSource = readFileSync(resolve(projectRoot, "packages/worker-runtime/src/scenario-process-runtime.ts"), "utf8");
const scenarioCompositionSource = readFileSync(resolve(projectRoot, "apps/server/src/governed-execution-sources.ts"), "utf8");
const scenarioCapabilitySource = readFileSync(resolve(projectRoot, "apps/server/src/scenario-process-capabilities.ts"), "utf8");
const scenarioSupervisionSource = readFileSync(resolve(projectRoot, "apps/server/src/scenario-process-supervision.ts"), "utf8");
const scenarioColdArchiveSource = readFileSync(resolve(projectRoot, "apps/server/src/scenario-process-cold-archive.ts"), "utf8");
const scenarioObserverAcceptanceSource = readFileSync(resolve(projectRoot, "apps/server/src/scenario-capability-observer-acceptance.ts"), "utf8");
const scenarioRecoveryIssuerSource = readFileSync(resolve(projectRoot, "apps/server/src/scenario-capability-recovery-issuer.ts"), "utf8");
const scenarioDeclarativeContractSource = readFileSync(resolve(projectRoot, "packages/scenario-sdk/src/declarative-contracts.ts"), "utf8");
const scenarioDescriptorSource = readFileSync(resolve(projectRoot, "packages/scenario-sdk/src/package-descriptor.ts"), "utf8");
const scenarioDescriptorLoaderSource = readFileSync(resolve(projectRoot, "apps/server/src/scenario-package-descriptor-loader.ts"), "utf8");
const securityAgentFoundationSource = readFileSync(resolve(projectRoot, "apps/server/src/security-agent-foundation.ts"), "utf8");
if (!/SCENARIO_PROCESS_PROTOCOL_VERSION\s*=\s*1/.test(scenarioProcessSource)
  || !/class ScenarioPackageCapabilityBroker\b/.test(scenarioProcessSource)
  || !/class ScenarioProcessRuntime\b/.test(scenarioProcessSource)
  || !/interface ScenarioExecutionNodeProcessLaunch\b/.test(scenarioProcessSource)
  || !/interface ScenarioProcessSupervisionStore\b/.test(scenarioProcessSource)
  || !/new ExecutionNodeToolProviderClient/.test(scenarioProcessSource)
  || !/claimCapabilityReceipt/.test(scenarioProcessSource)
  || !/provider\.profile !== SCENARIO_PROCESS_PROTOCOL/.test(scenarioProcessSource)) {
  violations.push("worker-runtime must retain the versioned Scenario Process profile, OS-backed launch and durable capability broker");
}
if (!/if \(installation\.runtime\)/.test(scenarioCompositionSource)
  || !/createScenarioProcessCapabilityHandlers/.test(scenarioCompositionSource)
  || !/requires Execution Node and durable supervision/.test(scenarioCompositionSource)
  || !/origin: "scenario_process"/.test(scenarioCompositionSource)) {
  violations.push("production foundation must assemble process-declared Scenario Packages without invoking their in-process factory");
}
if (!/allowInProcessDevelopment = false/.test(scenarioCompositionSource)
  || !/cannot execute in the trusted Host/.test(scenarioCompositionSource)
  || !/allowInProcessScenarioDevelopment/.test(securityAgentFoundationSource)
  || !/inProcessScenarioExecution/.test(securityAgentFoundationSource)
  || !/outside explicit development mode/.test(scenarioSdkSource)) {
  violations.push("Production Scenario tool execution must remain process-only with an explicit development-only in-process escape hatch");
}
if (!/traceforge\.scenario-scope-policy\.v1/.test(scenarioDeclarativeContractSource)
  || !/traceforge\.scenario-output-contract\.v1/.test(scenarioDeclarativeContractSource)
  || !/maximumDepth/.test(scenarioDeclarativeContractSource)
  || !/payloadPath/.test(scenarioDeclarativeContractSource)
  || !/mapDeclarativeEvidence/.test(scenarioDeclarativeContractSource)
  || !/allowLegacyScenarioContractDevelopment/.test(securityAgentFoundationSource)
  || !/new ScenarioPackageRegistry\(trustedScenarioPackages\.list\(\),pkg=>/.test(securityAgentFoundationSource)
  || !/trustedScenarioPackages\.assertAvailable\(pkg\)/.test(securityAgentFoundationSource)
  || !/must use valid declarative authorization and output contracts/.test(securityAgentFoundationSource)) {
  violations.push("Production Scenario authorization, output validation and evidence mapping must remain declarative and bounded");
}
if (!/traceforge\.scenario-package\.v1/.test(scenarioDescriptorSource)
  || !/Unknown Scenario Package descriptor field/.test(scenarioDescriptorSource)
  || !/deepFreeze/.test(scenarioDescriptorSource)
  || !/Local Scenario resource locator/.test(scenarioDescriptorSource)
  || !/scenario\.json/.test(scenarioDescriptorLoaderSource)
  || !/O_NOFOLLOW/.test(scenarioDescriptorLoaderSource)
  || !/safeMaterialPath/.test(scenarioDescriptorLoaderSource)
  || !/TextDecoder\("utf-8",\{fatal:true\}\)/.test(scenarioDescriptorLoaderSource)
  || !/runtime does not match the reviewed entry/.test(scenarioDescriptorLoaderSource)
  || !/resource does not match reviewed data material/.test(scenarioDescriptorLoaderSource)
  || !/readScenarioPackageDescriptorResources/.test(scenarioDescriptorLoaderSource)
  || !/loadScenarioPackageDescriptors/.test(securityAgentFoundationSource)
  || !/descriptorResources\.context/.test(securityAgentFoundationSource)
  || !/descriptorResources\.migrations/.test(securityAgentFoundationSource)
  || !/options\.loadScenarioPackageDescriptors\?binding=>/.test(securityAgentFoundationSource)) {
  violations.push("Production Scenario Packages must retain bounded data-only descriptor loading bound to reviewed runtime and resource material");
}
if (!/class SqliteScenarioProcessSupervisionStore\b/.test(scenarioSupervisionSource)
  || !/recoverInterrupted/.test(scenarioSupervisionSource)
  || !/restart budget exhausted/.test(scenarioSupervisionSource)
  || !/status='pending'/.test(scenarioSupervisionSource)) {
  violations.push("production foundation must retain durable Scenario Process generations, retry budgets and unresolved capability fencing");
}
if (!/packageId: installation\.id/.test(scenarioCapabilitySource)
  || !/caseId: attribution\.caseId/.test(scenarioCapabilitySource)
  || !/runId: attribution\.runId/.test(scenarioCapabilitySource)) {
  violations.push("Scenario Process host capabilities must inject Package and active Work ownership on the Host");
}
if (/better-sqlite3|Database\b/.test(scenarioColdArchiveSource)
  || !/verifyScenarioProcessArchiveExport/.test(scenarioColdArchiveSource)
  || !/fsyncSync/.test(scenarioColdArchiveSource)
  || !/renameSync/.test(scenarioColdArchiveSource)
  || !/"forensic_hold"/.test(scenarioColdArchiveSource)
  || !/secureErase:false/.test(scenarioColdArchiveSource)) {
  violations.push("Scenario Process cold archives must remain SQLite-independent, verified, atomically published and forensic-hold by default");
}
if (!/new WeakMap<ScenarioCapabilityRecoveryObserver/.test(scenarioObserverAcceptanceSource)
  || !/probes\.length<2/.test(scenarioObserverAcceptanceSource)
  || !/captureExternalState/.test(scenarioObserverAcceptanceSource)
  || !/acceptance cancellation probe/.test(scenarioObserverAcceptanceSource)
  || !/assertScenarioCapabilityObserverAcceptance/.test(scenarioRecoveryIssuerSource)) {
  violations.push("Scenario capability recovery Issuers must retain instance-bound Observer deployment acceptance");
}

const executionProtocolSource = readFileSync(resolve(projectRoot, "packages/execution-node/src/protocol.ts"), "utf8");
const executionRuntimeSource = readFileSync(resolve(projectRoot, "packages/execution-node/src/runtime.ts"), "utf8");
const executionRpcSource = readFileSync(resolve(projectRoot, "packages/execution-node/src/rpc.ts"), "utf8");
const nativeTerminalSource = readFileSync(resolve(projectRoot, "packages/execution-node/src/native-terminal.ts"), "utf8");
const sandboxPolicySource = readFileSync(resolve(projectRoot, "packages/execution-node/src/sandbox-policy.ts"), "utf8");
const linuxHelperContractSource = readFileSync(resolve(projectRoot, "packages/execution-node/src/linux-helper-contract.ts"), "utf8");
const linuxHelperNativeSource = readFileSync(resolve(projectRoot, "packages/linux-sandbox-helper/src/linux.rs"), "utf8");
const linuxHelperBuildSource = readFileSync(resolve(projectRoot, "scripts/build-linux-sandbox-helper.mts"), "utf8");
const linuxHelperAcceptanceSource = readFileSync(resolve(projectRoot, "scripts/verify-linux-sandbox-native.mjs"), "utf8");
const linuxDeploymentVerificationSource = readFileSync(resolve(projectRoot, "scripts/verify-linux-deployment-assets.mjs"), "utf8");
const linuxDesktopLauncherSource = readFileSync(resolve(projectRoot, "packages/linux-sandbox-helper/packaging/traceforge-sandboxed"), "utf8");
const linuxDesktopInstallSource = readFileSync(resolve(projectRoot, "packages/linux-sandbox-helper/packaging/deb-after-install.sh"), "utf8");
const desktopPackage = JSON.parse(readFileSync(resolve(projectRoot, "apps/desktop/package.json"), "utf8"));
const nativeHelperReleaseSource = readFileSync(resolve(projectRoot, "packages/execution-node/src/native-helper-release.ts"), "utf8");
const localExecutionLifecycleSource = readFileSync(resolve(projectRoot, "apps/server/src/local-execution-node-lifecycle.ts"), "utf8");
const desktopMainSource = readFileSync(resolve(projectRoot, "apps/desktop/src/main.ts"), "utf8");
const desktopReleaseVerificationSource = readFileSync(resolve(projectRoot, "scripts/verify-desktop-release.mts"), "utf8");
const executionNodeServiceSource = readFileSync(resolve(projectRoot, "apps/server/src/execution-node-service.ts"), "utf8");
const processOperationJournalSource = readFileSync(resolve(projectRoot, "apps/server/src/execution-process-operation-journal.ts"), "utf8");
const localOperationCrashTestSource = readFileSync(resolve(projectRoot, "apps/server/src/local-execution-operation-crash.integration.test.ts"), "utf8");
const operationJournalTestSource = readFileSync(resolve(projectRoot, "apps/server/src/execution-process-operation-journal.integration.test.ts"), "utf8");
const extensionAssemblySource = readFileSync(resolve(projectRoot, "apps/server/src/extension-assembly.ts"), "utf8");
const mcpExecutionSource = readFileSync(resolve(projectRoot, "apps/server/src/mcp-execution-source.ts"), "utf8");
const foundationDeploymentSource = readFileSync(resolve(projectRoot, "apps/server/src/foundation-deployment.ts"), "utf8");
if (!/EXECUTION_PROTOCOL_VERSION\s*=\s*\{ major: 1, minor: 8 \}/.test(executionProtocolSource)
  || !/backendMeasurement/.test(executionProtocolSource)
  || !/sandbox backend measurement does not match/.test(executionRuntimeSource)
  || !/TraceForge Linux sandbox helper changed after startup; execution denied/.test(executionNodeServiceSource)
  || !/parseLinuxSandboxHelperProbe/.test(localExecutionLifecycleSource)
  || /\bbwrap\b|bubblewrap/i.test(`${executionNodeServiceSource}\n${localExecutionLifecycleSource}`)) {
  violations.push("Linux process execution must remain bound to a measured TraceForge native helper and fail closed on replacement");
}
if (!["process.writeInput", "process.resizeTerminal", "process.signal", "process.terminate", "process.adopt"]
  .every((operation) => localOperationCrashTestSource.includes(`\"${operation}\"`))
  || !/after-claim/.test(localOperationCrashTestSource)
  || !/after-complete/.test(localOperationCrashTestSource)
  || !/SIGKILL/.test(localOperationCrashTestSource)) {
  violations.push("Local process controls must retain the cross-host claim-only and committed-response-loss crash matrix");
}
if (!/atomicCgroupAssignment/.test(linuxHelperContractSource)
  || !/cgroupEmptyBarrier/.test(linuxHelperContractSource)
  || !/terminal:\s*true/.test(linuxHelperContractSource)
  || !/noNewPrivileges/.test(linuxHelperContractSource)
  || !/seccomp/.test(linuxHelperContractSource)) {
  violations.push("Linux helper readiness must retain namespace, cgroup-v2, seccomp and process-tree lifecycle proof requirements");
}
if (!/class NativeTerminalProcessLauncher/.test(nativeTerminalSource)
  || !/compileLinuxPtySandboxLaunch/.test(sandboxPolicySource)
  || !/pub fn pty_run/.test(linuxHelperNativeSource)
  || !/FRAME_RESIZE/.test(linuxHelperNativeSource)
  || !/terminal-input-resize-terminate/.test(linuxHelperAcceptanceSource)
  || !/terminal-interrupt/.test(linuxHelperAcceptanceSource)
  || !/terminal-close-input/.test(linuxHelperAcceptanceSource)
  || !/tty:\s*processReady/.test(executionNodeServiceSource)) {
  violations.push("Linux production execution must retain the framed native PTY path and its release acceptance cases");
}
if (!/SYS_clone3/.test(linuxHelperNativeSource)
  || !/CLONE_INTO_CGROUP/.test(linuxHelperNativeSource)
  || !/SYS_pivot_root/.test(linuxHelperNativeSource)
  || !/PR_SET_SECCOMP/.test(linuxHelperNativeSource)
  || !/PR_SET_NO_NEW_PRIVS/.test(linuxHelperNativeSource)
  || !/cgroup\.kill/.test(linuxHelperNativeSource)
  || !/TRACEFORGE_TARGET_ENV_/.test(linuxHelperNativeSource)
  || !/TRACEFORGE_LINUX_CGROUP_ROOT/.test(localExecutionLifecycleSource)
  || !/parseLinuxSandboxHelperProbe/.test(linuxHelperBuildSource)) {
  violations.push("Linux native helper must retain atomic cgroup placement, namespace filesystem isolation, seccomp, controlled environment, cleanup and release probe gates");
}
if (!/pub fn recover/.test(linuxHelperNativeSource)
  || !/recoveredCgroups/.test(linuxHelperNativeSource)
  || !/helper-kill-and-startup-recovery/.test(linuxHelperAcceptanceSource)
  || !/PR_SET_PDEATHSIG/.test(linuxHelperNativeSource)
  || !/execution-host-kill-chain-and-restart-recovery/.test(linuxHelperAcceptanceSource)
  || !/verify-linux-sandbox-native/.test(linuxHelperBuildSource)) {
  violations.push("Linux native release must retain crash-residue recovery and helper-kill acceptance gates");
}
if (JSON.stringify(desktopPackage.build?.linux?.target) !== JSON.stringify(["deb"])
  || desktopPackage.build?.linux?.desktop?.entry?.Exec !== "/usr/bin/traceforge %U"
  || !/systemd-run --user --scope/.test(linuxDesktopLauncherSource)
  || !/Delegate=yes/.test(linuxDesktopLauncherSource)
  || !/\+cpu \+io \+memory \+pids/.test(linuxDesktopLauncherSource)
  || !/apparmor_parser -r/.test(linuxDesktopInstallSource)
  || !/rollback/.test(linuxDesktopInstallSource)
  || !/linux_deployment_not_installed/.test(localExecutionLifecycleSource)
  || !/portable_or_direct_launch/.test(desktopMainSource)
  || !/dpkg-deb/.test(desktopReleaseVerificationSource)
  || !/DEB-only/.test(linuxDeploymentVerificationSource)) {
  violations.push("Linux Desktop process readiness must require the DEB-installed AppArmor and delegated systemd user-scope deployment");
}
if (!/interface ExecutionRpcAddress \{ kind: "pipe"; path: string \}/.test(executionRpcSource)
  || /node:tls|mutual_tls|kind:\s*"tls"/.test(executionRpcSource)
  || !/class SqliteProcessOperationJournal/.test(processOperationJournalSource)
  || !/operationJournal,/.test(executionNodeServiceSource)
  || /TrustedRemoteExecutionNode|remoteExecutionNodeTrust|remoteExecutionReconciliation/.test(
    `${executionNodeServiceSource}\n${securityAgentFoundationSource}`)) {
  violations.push("Execution Node transport must remain local-only while retaining durable per-operation process reliability");
}
if (!/compactCompletedHistory/.test(processOperationJournalSource)
  || !/archived_response/.test(processOperationJournalSource)
  || !/state='claimed'/.test(processOperationJournalSource)
  || !/processOperationJournalHealth/.test(executionNodeServiceSource)
  || !/before-commit/.test(operationJournalTestSource)
  || !/after-commit/.test(operationJournalTestSource)
  || !/SIGKILL/.test(operationJournalTestSource)) {
  violations.push("Process control reliability must retain bounded transparent archives, uncertain claims and archive crash recovery");
}
if (!/class ExtensionAssemblyControl/.test(extensionAssemblySource)
  || !/traceforge\.extension-assembly\.v1/.test(extensionAssemblySource)
  || !/extension_assembly_activations/.test(extensionAssemblySource)
  || !/extension_assembly_profile_revocations/.test(extensionAssemblySource)
  || !/authorizeProfileRollback/.test(extensionAssemblySource)
  || !/assertProfileAvailable/.test(extensionAssemblySource)
  || !/managed_provider/.test(extensionAssemblySource)
  || !/attachManagedProviderInventory/.test(extensionAssemblySource)
  || !/extension_assembly_process_profiles/.test(extensionAssemblySource)
  || !/extension_assembly_archives/.test(extensionAssemblySource)
  || !/archiveAuthorizer/.test(extensionAssemblySource)
  || !/history\/archive/.test(extensionAssemblySource)
  || !/gunzipSync/.test(extensionAssemblySource)
  || !/scenarioProcessLaunches/.test(extensionAssemblySource)
  || !/Extension profile rollback requires an explicit control-plane operation/.test(extensionAssemblySource)
  || !/mcpToolProfileDigest/.test(mcpExecutionSource)
  || !/allowedPackageKeys\.has/.test(mcpExecutionSource)
  || !/assertProfileAvailable\(\)/.test(mcpExecutionSource)
  || !/packages:\s*readonly ScenarioPackageBinding\[\]/.test(mcpExecutionSource)
  || !/"extension_assembly"/.test(foundationDeploymentSource)
  || !/new ExtensionAssemblyControl/.test(securityAgentFoundationSource)
  || !/attachManagedProviderInventory/.test(readFileSync(resolve(projectRoot, "apps/server/src/embedded-workers.ts"), "utf8"))) {
  violations.push("Foundation extensions must retain immutable assembly identity, exact Package binding, runtime revocation, explicit rollback and authorized bounded history archives");
}
if (!/NATIVE_HELPER_RELEASE_PROFILE/.test(nativeHelperReleaseSource)
  || !/verifyNativeHelperRelease/.test(localExecutionLifecycleSource)
  || !/release_manifest_missing/.test(localExecutionLifecycleSource)
  || !/helper_measurement_changed/.test(localExecutionLifecycleSource)
  || !/TRACEFORGE_REQUIRE_NATIVE_HELPER_RELEASE_MANIFEST/.test(desktopMainSource)
  || !/autoInstallOnAppQuit\s*=\s*false/.test(desktopMainSource)
  || !/verifyNativeHelperRelease/.test(desktopReleaseVerificationSource)
  || !/async shutdown\(/.test(executionRuntimeSource)) {
  violations.push("Local Execution Node releases must retain packaged helper identity, startup preflight, drift health and bounded process-tree shutdown");
}

if (violations.length) {
  throw new Error(`Foundation boundary violations:\n${[...new Set(violations)].map((item) => `- ${item}`).join("\n")}`);
}

console.log(`Foundation boundary verified across ${foundationSources.length} production source files.`);
