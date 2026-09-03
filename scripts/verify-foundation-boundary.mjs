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
