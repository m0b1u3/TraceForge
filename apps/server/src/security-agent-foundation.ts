import type Database from "better-sqlite3";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { LlmProvider } from "@traceforge/llm";
import type { ScenarioAgentEvent } from "@traceforge/shared";
import type { ExecutionNode } from "@traceforge/execution-node";
import { ContextCompactionRuntime, type ContextCompactor } from "@traceforge/cognitive-runtime";
import { SqliteContextCompactionStore } from "./context-compaction-store.js";
import { RunContextPolicy } from "./run-context-policy.js";
import {
  createProviderCapabilityHost,
  JsonFileCheckpointStore,
  type ExecutionToolDiscoverySource,
  type ProviderCapabilityBrokerLimits,
  type ProviderCapabilityHandler,
  type ProviderCapabilityPolicy,
} from "@traceforge/worker-runtime";
import { registerEmbeddedWorkers } from "./embedded-workers.js";
import { registerScenarioRoutes } from "./scenario-routes.js";
import { ExecutionSessionGateway, loadOrCreateVaultKey, SqliteEncryptedSecretVault } from "./execution-session-gateway.js";
import { registerExecutionSessionRoutes } from "./execution-session-routes.js";
import { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { ScenarioEvidenceGraphAdapter } from "./scenario-evidence-store.js";
import { registerEvidenceGraphRoutes } from "./evidence-graph-routes.js";
import { DurableScenarioRuntime, ScenarioDefinitionRegistry } from "@traceforge/orchestration-core";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";
import { registerRunObserverRoutes, RunObserverSupervisor, SqliteRunObserverStore, StructuredRunObserverModel } from "./run-observer.js";
import { registerRunPlannerRoutes, RunPlannerSupervisor, SqliteRunPlannerStore, StructuredRunPlannerModel } from "./run-planner.js";
import { BlackboardChangeBus } from "@traceforge/cognitive-runtime";
import { SqliteCognitiveContextCursorStore } from "./cognitive-context-distiller.js";
import { registerCognitiveSnapshotRoutes, SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import {
  DEFAULT_MODEL_ROLE_POLICIES,
  ModelExecutionRuntime,
  registerModelExecutionRoutes,
  SqliteModelExecutionStore,
  type CognitiveModelRole,
  type ModelRolePolicy,
} from "./model-execution-runtime.js";
import {
  DEFAULT_MODEL_RESOURCE_POLICY,
  ModelAdmissionController,
  registerModelAdmissionRoutes,
  SqliteModelAdmissionStore,
  type ModelResourcePolicy,
  type ModelResourcePolicyOverrides,
} from "./model-admission-controller.js";
import { registerScenarioAgentEventRoutes, SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { AgentAuditProjection } from "./agent-audit-projection.js";
import { registerScenarioCollaborationRoutes, ScenarioCollaborationSnapshotService } from "./scenario-collaboration-snapshot.js";
import { registerScenarioRunRecoveryRoutes, ScenarioRunRecoveryService } from "./scenario-run-recovery.js";
import type { ToolProviderInstallation } from "./tool-provider-control-plane.js";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { ScenarioPackageTrustControl, registerScenarioPackageTrustRoutes, type ScenarioPackageTrustOptions } from "./scenario-package-trust.js";
import { ScenarioHistoryControl, registerScenarioHistoryRoutes, type ScenarioHistoryAuthorizer } from "./scenario-history-control.js";
import { readRunForensics, ScenarioRunDisposalControl, registerScenarioRunDisposalRoutes, type ScenarioRunDisposalAuthorizer } from "./scenario-run-disposal.js";
import { ScenarioAuthorizationUpgradeControl, registerAuthorizationUpgradeRoutes, type AuthorizationUpgradeOptions } from "./scenario-authorization-upgrade.js";
import { SqliteScenarioTrafficStore } from "./scenario-traffic-store.js";
import {
  ScenarioProviderCapabilityScopeAuthorizer,
  SqliteProviderCapabilityApprovalReader,
  SqliteProviderCapabilityReceiptStore,
} from "./provider-capability-adapters.js";
import type { ToolProviderArchiveImportAuthorizer } from "./tool-provider-archive-import.js";
import type { ToolProviderRefreshAuthorizer } from "./tool-provider-refresh-control.js";
import { ScenarioWorkRetryControl, registerScenarioWorkRetryRoutes, type ScenarioWorkRetryAuthorizer } from "./scenario-work-retry.js";
import { ScenarioWorkContinuationControl, registerScenarioWorkContinuationRoutes, type ScenarioWorkContinuationAuthorizer } from "./scenario-work-continuation.js";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";
import { ExecutionArchiveControl, registerExecutionArchiveRoutes, type ExecutionArchiveAuthorizer } from "./execution-archive-control.js";
import { GovernanceHistoryControl, registerGovernanceHistoryRoutes, type GovernanceHistoryAuthorizer } from "./governance-history-control.js";
import { StorageMaintenanceControl, registerStorageMaintenanceRoutes, type StorageMaintenanceAuthorizer } from "./storage-maintenance.js";
import type {
  ToolInvocationReconciliationAuthorizer,
  ToolInvocationReconciliationEvidenceVerifier,
} from "./tool-invocation-reconciliation.js";
import type { RecoveryEvidenceAuthority } from "./tool-recovery-evidence.js";
import { PackageContextDiscoverySource, SqlitePackageContextStore, type PackageContextContent } from "./package-context-resources.js";
import { createFoundationMcpSource, type FoundationMcpServer } from "./mcp-execution-source.js";
import { PackageContextPolicy } from "./package-context-policy.js";
import { createMcpContextLoader, mcpContextProfileDigest, type FoundationMcpContextServer } from "./mcp-context-loader.js";
import { PackageContextLifecycle, registerContextLifecycleRoutes, type ContextLifecycleAuthorizer } from "./package-context-lifecycle.js";
import { ContextPackageArchiveControl, registerContextPackageArchiveRoutes, type ContextPackageTransferOptions } from "./context-package-archive.js";
import { ProcessExecutionCapacity, registerProcessCapacityRoutes, type ProcessCleanupAuthorizer } from "./process-execution-capacity.js";
import { ToolProviderFairScheduler, type ToolProviderSchedulingLimits } from "@traceforge/worker-runtime";
import { SqliteToolProviderSchedulingAuditStore } from "./tool-provider-scheduling-adapter.js";
import { GovernedExecutionSources } from "./governed-execution-sources.js";
import { registerFoundationHostControl } from "./foundation-host-control.js";
import { FoundationBackupControl, registerFoundationBackupRoutes, registerFoundationInspectionRoutes, type FoundationBackupOptions } from "./foundation-backup.js";
import { FoundationOfflineMediaControl, registerFoundationOfflineMediaRoutes, type FoundationOfflineMediaOptions } from "./foundation-offline-media.js";
import { FoundationBackupRetentionControl, registerFoundationRetentionRoutes, type FoundationRetentionAuthorizer } from "./foundation-backup-retention.js";
import type { FoundationRecoveryReadinessOptions } from "./foundation-recovery-readiness.js";
import { FoundationRecoveryActivationControl, registerFoundationRecoveryActivationRoutes, type FoundationRecoveryActivationOptions } from "./foundation-recovery-activation.js";
import { assertFoundationRestorePublished, assertNotBackupSource, assertNoIncompleteRestore, readFoundationRestoreFence } from "./db/foundation-restore-fence.js";
import { ScenarioRunMigrationControl, registerScenarioRunMigrationRoutes, type ScenarioRunMigrationOptions } from "./scenario-run-migration.js";
import type { ExecutionSourcePolicy, GovernedExecutionSourceRegistration } from "@traceforge/worker-runtime";

export interface SecurityAgentFoundationOptions {
  backup?: FoundationBackupOptions;
  offlineMedia?: FoundationOfflineMediaOptions;
  retentionAuthorizer?: FoundationRetentionAuthorizer;
  recoveryReadiness?: FoundationRecoveryReadinessOptions;
  recoveryActivation?: FoundationRecoveryActivationOptions;
  historyArchiveAuthorizer?: ScenarioHistoryAuthorizer;
  runDisposalAuthorizer?: ScenarioRunDisposalAuthorizer;
  scenarioPackageTrust?:ScenarioPackageTrustOptions;
  authorizationUpgrade?: AuthorizationUpgradeOptions;
  scenarioRunMigration?: ScenarioRunMigrationOptions;
  /** Optional host adapter. Default is bounded extractive text, not a semantic model call. */
  contextCompactor?: ContextCompactor;
  contextResourceContents?: readonly PackageContextContent[];
  revokedContextResources?: readonly { digest: string; reason: string }[];
  mcpServers?: readonly FoundationMcpServer[];
  mcpContextServers?: readonly FoundationMcpContextServer[];
  contextLifecycleAuthorizer?: ContextLifecycleAuthorizer;
  contextPackageTransfer?: Omit<ContextPackageTransferOptions,"hasExternalProfile">;
  executionSchedulingLimits?: Partial<ToolProviderSchedulingLimits>;
  processCleanupAuthorizer?: ProcessCleanupAuthorizer;
  storageMaintenanceAuthorizer?: StorageMaintenanceAuthorizer;
  executionArchiveAuthorizer?: ExecutionArchiveAuthorizer;
  governanceHistoryAuthorizer?: GovernanceHistoryAuthorizer;
  workRetryAuthorizer?: ScenarioWorkRetryAuthorizer;
  workContinuationAuthorizer?: ScenarioWorkContinuationAuthorizer;
  scenarioPackageRegistry?: ScenarioPackageRegistry;
  autoScheduleIntervalMs?: number;
  modelRoutes?: ReadonlyMap<string, LlmProvider>;
  modelPolicies?: Partial<Record<CognitiveModelRole, Partial<ModelRolePolicy>>>;
  modelResourcePolicy?: ModelResourcePolicyOverrides;
  onAgentEvent?: (event: ScenarioAgentEvent) => void;
  executionNode?: ExecutionNode;
  toolDiscoverySources?: readonly ExecutionToolDiscoverySource[];
  governedToolSources?: readonly GovernedExecutionSourceRegistration[];
  scenarioSourceExecutionPolicies?: Readonly<Record<string, ExecutionSourcePolicy>>;
  governedToolProviderFactory?: (installation: ToolProviderInstallation) => Promise<GovernedExecutionSourceRegistration> | GovernedExecutionSourceRegistration;
  /** Explicit fixture/migration escape hatch. Never reported as governed or production coverage. */
  allowUnmanagedDevelopmentSources?: boolean;
  toolProviderTrustRoots?: ReadonlyMap<string, string>;
  toolProviderSourceFactory?: (installation: ToolProviderInstallation) => Promise<ExecutionToolDiscoverySource> | ExecutionToolDiscoverySource;
  toolProviderArchiveImportAuthorizer?: ToolProviderArchiveImportAuthorizer;
  toolProviderRefreshAuthorizer?: ToolProviderRefreshAuthorizer;
  toolInvocationReconciliationAuthorizer?: ToolInvocationReconciliationAuthorizer;
  toolInvocationReconciliationEvidenceVerifier?: ToolInvocationReconciliationEvidenceVerifier;
  toolRecoveryEvidenceAuthority?: (keyId: string) => RecoveryEvidenceAuthority | undefined;
  providerCapabilities?: {
    handlers: ProviderCapabilityHandler[];
    policies: ProviderCapabilityPolicy[];
    limits?: Partial<ProviderCapabilityBrokerLimits>;
  };
}

/**
 * The standalone security-agent runtime composition root.
 *
 * Keep this module free of the retired chat-oriented AgentRuntime and its tool
 * registry. Scenario state, leases, checkpoints, approvals and Worker tools
 * are assembled exclusively through orchestration-core and worker-runtime.
 */
export function registerSecurityAgentFoundation(
  app: FastifyInstance,
  sqlite: Database.Database,
  provider: LlmProvider,
  projectRoot: string,
  providerReady: () => boolean,
  options: SecurityAgentFoundationOptions = {},
): void {
  assertNotBackupSource(sqlite.name);
  const restoreFence = readFoundationRestoreFence(sqlite);
  assertNoIncompleteRestore(sqlite, restoreFence);
  if (restoreFence) {
    assertFoundationRestorePublished(sqlite, restoreFence);
    registerFoundationHostControl(app, sqlite);
    registerFoundationInspectionRoutes(app, sqlite, options.recoveryReadiness, options.recoveryActivation);
    return;
  }
  if(!options.allowUnmanagedDevelopmentSources && ((options.toolDiscoverySources?.length ?? 0)>0 || options.toolProviderSourceFactory)) {
    throw new Error("Unmanaged custom sources are disabled; register governed factories or explicitly opt into development-only sources");
  }
  if(options.toolProviderSourceFactory && options.governedToolProviderFactory)throw new Error("Conflicting custom provider factories");
  const hostControl=registerFoundationHostControl(app,sqlite);
  app.get("/api/security-tools/host-channels",async()=>hostControl.snapshot());
  if(options.recoveryActivation){if(options.recoveryActivation.auditDb===sqlite)throw new Error("Recovery activation audit must remain outside the active database");
    registerFoundationRecoveryActivationRoutes(app,new FoundationRecoveryActivationControl(options.recoveryActivation));}
  if (options.backup) {
    const backupControl=new FoundationBackupControl(sqlite,options.backup);registerFoundationBackupRoutes(app,backupControl);
    const mediaControl=options.offlineMedia?new FoundationOfflineMediaControl(sqlite,backupControl,options.offlineMedia):undefined;
    if(mediaControl)registerFoundationOfflineMediaRoutes(app,mediaControl);
    else app.get("/api/foundation/media",async()=>({enabled:false,reason:"Trusted host media keys, authorities and directory are not configured"}));
    registerFoundationRetentionRoutes(app,new FoundationBackupRetentionControl(sqlite,backupControl,mediaControl,options.retentionAuthorizer));
  } else {
    app.get("/api/foundation/backups", async () => ({ enabled: false, reason: "Trusted host backup directories and independent authorization are not configured" }));
    app.get("/api/foundation/media",async()=>({enabled:false,reason:"Backup control is unavailable"}));
    app.get("/api/foundation/retention/inventory",async()=>({enabled:false,reason:"Backup control is unavailable"}));
  }
  const sessions = new ExecutionSessionGateway(
    sqlite,
    new SqliteEncryptedSecretVault(sqlite, loadOrCreateVaultKey(projectRoot)),
  );
  const changes = new BlackboardChangeBus();
  const evidenceGraph = new SqliteEvidenceGraphStore(sqlite, changes);
  const scenarioEvidence = new ScenarioEvidenceGraphAdapter(evidenceGraph);
  const packageTrust=new ScenarioPackageTrustControl(sqlite,options.scenarioPackageRegistry??new ScenarioPackageRegistry(),options.scenarioPackageTrust);
  const scenarioPackages=packageTrust.registry;
  registerScenarioPackageTrustRoutes(app,packageTrust);
  const authorization = new SqliteScenarioAuthorizationService(sqlite, scenarioPackages);
  const providerCapabilityHost = createProviderCapabilityHost({
    handlers: options.providerCapabilities?.handlers ?? [],
    policies: options.providerCapabilities?.policies ?? [],
    limits: options.providerCapabilities?.limits,
    receipts: new SqliteProviderCapabilityReceiptStore(sqlite),
    scopes: new ScenarioProviderCapabilityScopeAuthorizer(authorization),
    approvals: new SqliteProviderCapabilityApprovalReader(sqlite),
  });
  const traffic = new SqliteScenarioTrafficStore(sqlite);
  const definitions = new ScenarioDefinitionRegistry(scenarioPackages.definitions());
  const scenarioEvents = new SqliteScenarioEventStore(sqlite, changes);
  const workers = new SqliteWorkerRegistry(sqlite);
  const scenarioRuntime = new DurableScenarioRuntime(scenarioEvents, definitions, scenarioPackages);
  const processCapacity=new ProcessExecutionCapacity(sqlite,new ToolProviderFairScheduler(options.executionSchedulingLimits,
    new SqliteToolProviderSchedulingAuditStore(sqlite)));
  const governedSources=new GovernedExecutionSources(options.executionNode,processCapacity);
  const customSources=(options.governedToolSources??[]).map(source=>governedSources.register(source));
  const scenarioSources=governedSources.scenarioSources(scenarioPackages,
    {sessions,authorization,traffic,evidence:scenarioEvidence},options.scenarioSourceExecutionPolicies);
  const customProviderFactory=options.governedToolProviderFactory ? (installation:ToolProviderInstallation)=>
    governedSources.registerProvider(installation,options.governedToolProviderFactory!) : options.toolProviderSourceFactory;
  registerProcessCapacityRoutes(app,processCapacity,options.processCleanupAuthorizer,options.toolRecoveryEvidenceAuthority??(()=>undefined));
  const capacityCoverage=Object.freeze({
    builtinProcess:!!options.executionNode,defaultManagedProviders:!customProviderFactory,
    mcpTools:(options.mcpServers??[]).map(server=>server.source),mcpContext:(options.mcpContextServers??[]).map(server=>server.source),
    customDiscoverySources:(options.toolDiscoverySources??[]).map(source=>source.source),
    customSourcesAndScenarioExecutionPorts:"host_scoped",singleHostOnly:true,
    unmanagedDevelopmentSources:options.allowUnmanagedDevelopmentSources===true,
    unmanagedProviderFactory:!!options.toolProviderSourceFactory,arbitraryJavaScriptIsolation:false,
    accounting:"invocation_or_process_not_os_tree",automaticCleanupProofIssuer:false,
  });
  app.get("/api/security-tools/process-capacity-policy",async()=>({limits:processCapacity.scheduler.limits,
    coverage:{...capacityCoverage,governedSources:governedSources.diagnostics()}}));
  let contextArchives: ContextPackageArchiveControl;
  const contextStore = new SqlitePackageContextStore(sqlite,undefined,(binding)=>contextArchives.assertImportedTrust(binding));
  const contextServers = options.mcpContextServers ?? [];
  contextArchives=new ContextPackageArchiveControl(sqlite,scenarioPackages,contextStore,{
    ...options.contextPackageTransfer,
    hasExternalProfile:(source,digest)=>contextServers.some(server=>server.source===source && mcpContextProfileDigest(server)===digest),
  });
  registerContextPackageArchiveRoutes(app,contextArchives);
  contextStore.install(scenarioPackages, options.contextResourceContents ?? []);
  for (const item of options.revokedContextResources ?? []) contextStore.revoke(item.digest, item.reason);
  registerContextLifecycleRoutes(app, new PackageContextLifecycle(sqlite, scenarioPackages, contextStore, options.contextLifecycleAuthorizer));
  if (new Set(contextServers.map((server) => server.source)).size !== contextServers.length) throw new Error("Duplicate MCP context source");
  const contextSource = new PackageContextDiscoverySource(scenarioPackages, contextStore, sqlite, (id) => scenarioRuntime.load(id) ?? null,
    new Map(contextServers.map((server) => [server.source, createMcpContextLoader(server, options.executionNode,processCapacity)])));
  const mcpSources = (options.mcpServers ?? []).map((config) => createFoundationMcpSource(config, options.executionNode,
    sqlite, scenarioPackages, (id) => scenarioRuntime.load(id) ?? null,processCapacity));
  const observerStore = new SqliteRunObserverStore(sqlite);
  const cognitiveCursors = new SqliteCognitiveContextCursorStore(sqlite);
  const agentEvents = new SqliteScenarioAgentEventStream(sqlite, options.onAgentEvent);
  const auditProjection = new AgentAuditProjection(sqlite, agentEvents);
  const snapshotRecoveryCutoff = (sqlite.prepare("SELECT coalesce(max(rowid),0) AS n FROM scenario_cognitive_snapshots").get() as {n:number}).n;
  const lifecycleEvents = agentEvents.bestEffortWriter((error) => {
    auditProjection.markDelayed(); app.log.warn({error},"Agent lifecycle projection delayed; source state retained");
  });
  const cognitiveSnapshots = new SqliteCognitiveSnapshotStore(sqlite, lifecycleEvents);
  cognitiveSnapshots.recoverPrepared(new Date().toISOString());
  const compactionStore = new SqliteContextCompactionStore(sqlite);
  compactionStore.recoverPrepared();
  const compaction = new ContextCompactionRuntime(compactionStore, options.contextCompactor);
  const runContext = new RunContextPolicy(sqlite, contextSource, (id) => scenarioRuntime.load(id) ?? null, cognitiveSnapshots);
  const contextPolicy = new PackageContextPolicy(sqlite, contextSource, runContext);
  const modelExecutionStore = new SqliteModelExecutionStore(sqlite);
  const modelAdmissionStore = new SqliteModelAdmissionStore(sqlite);
  const modelRoutes = new Map<string, LlmProvider>([["primary", provider], ...(options.modelRoutes?.entries() ?? [])]);
  const modelPolicies = Object.fromEntries(
    (Object.keys(DEFAULT_MODEL_ROLE_POLICIES) as CognitiveModelRole[]).map((role) => [
      role,
      { ...DEFAULT_MODEL_ROLE_POLICIES[role], ...options.modelPolicies?.[role] },
    ]),
  ) as Record<CognitiveModelRole, ModelRolePolicy>;
  const modelResourcePolicy: ModelResourcePolicy = {
    ...DEFAULT_MODEL_RESOURCE_POLICY,
    ...options.modelResourcePolicy,
    roleConcurrency: { ...DEFAULT_MODEL_RESOURCE_POLICY.roleConcurrency, ...options.modelResourcePolicy?.roleConcurrency },
    rolePriorities: { ...DEFAULT_MODEL_RESOURCE_POLICY.rolePriorities, ...options.modelResourcePolicy?.rolePriorities },
  };
  const modelAdmissions = new ModelAdmissionController(modelResourcePolicy, modelAdmissionStore, undefined, undefined, undefined, lifecycleEvents);
  const modelRuntime = new ModelExecutionRuntime(modelRoutes, modelPolicies, modelExecutionStore, modelAdmissions, undefined, undefined, lifecycleEvents);
  const observer = new RunObserverSupervisor(
    scenarioRuntime,
    definitions,
    scenarioEvents,
    evidenceGraph,
    observerStore,
    new StructuredRunObserverModel(provider, undefined, cognitiveSnapshots, undefined, modelRuntime, runContext, compaction),
    undefined,
    undefined,
    undefined,
    (error) => app.log.error({ err: error }, "Run Observer evaluation failed"),
    cognitiveCursors,
    runContext,
  );
  const plannerStore = new SqliteRunPlannerStore(sqlite);
  const planner = new RunPlannerSupervisor(
    scenarioRuntime,
    definitions,
    scenarioEvents,
    evidenceGraph,
    plannerStore,
    new StructuredRunPlannerModel(provider, undefined, cognitiveSnapshots, undefined, modelRuntime, runContext, compaction),
    4,
    undefined,
    undefined,
    (error) => app.log.error({ err: error }, "Run Planner evaluation failed"),
    runContext,
  );
  registerScenarioRoutes(app, sqlite, {
    definitions,
    packages: scenarioPackages,
    evidence: scenarioEvidence,
    autoScheduleIntervalMs: options.autoScheduleIntervalMs ?? 1_000,
    changeBus: changes,
  });
  registerExecutionSessionRoutes(app, sessions);
  registerEvidenceGraphRoutes(app, sqlite, evidenceGraph);
  registerRunObserverRoutes(app, observerStore);
  registerRunPlannerRoutes(app, plannerStore);
  const runRecovery = new ScenarioRunRecoveryService(scenarioRuntime, scenarioEvents, workers);
  registerScenarioCollaborationRoutes(app, new ScenarioCollaborationSnapshotService(
    scenarioRuntime,
    definitions,
    evidenceGraph,
    plannerStore,
    observerStore,
    workers,
    { cognitiveAgentsReady: providerReady },
  ));
  registerScenarioRunRecoveryRoutes(app, runRecovery);
  const workRetry = new ScenarioWorkRetryControl(sqlite, definitions, scenarioPackages, options.workRetryAuthorizer, changes);
  registerScenarioWorkRetryRoutes(app, workRetry);
  registerExecutionArchiveRoutes(app, new ExecutionArchiveControl(sqlite, options.executionArchiveAuthorizer));
  registerGovernanceHistoryRoutes(app,new GovernanceHistoryControl(sqlite,options.governanceHistoryAuthorizer));
  registerStorageMaintenanceRoutes(app, new StorageMaintenanceControl(sqlite, resolve(projectRoot, "data", "worker-checkpoints"), options.storageMaintenanceAuthorizer));
  registerScenarioWorkContinuationRoutes(app, new ScenarioWorkContinuationControl(sqlite, definitions,
    new SqliteWorkerCheckpointStore(sqlite, new JsonFileCheckpointStore(resolve(projectRoot, "data", "worker-checkpoints"))),
    scenarioPackages, options.workContinuationAuthorizer, changes));
  registerCognitiveSnapshotRoutes(app, cognitiveSnapshots, provider, providerReady, undefined, undefined,
    (snapshot) => contextPolicy.assertReplayAllowed(snapshot));
  registerModelExecutionRoutes(app, modelExecutionStore);
  registerModelAdmissionRoutes(app, modelAdmissions, modelAdmissionStore);
  registerScenarioAgentEventRoutes(app, agentEvents, auditProjection);
  registerEmbeddedWorkers(
    app, sqlite, provider, projectRoot, providerReady, evidenceGraph, changes,
    cognitiveSnapshots, modelRuntime, lifecycleEvents, definitions, scenarioPackages, options.executionNode,
    [...scenarioSources, contextSource],
    [...customSources, ...(options.toolDiscoverySources ?? []), ...mcpSources],
    options.toolProviderTrustRoots, customProviderFactory, providerCapabilityHost,
    options.toolProviderArchiveImportAuthorizer, options.toolProviderRefreshAuthorizer,
    options.toolInvocationReconciliationAuthorizer, options.toolInvocationReconciliationEvidenceVerifier,
    workRetry, options.toolRecoveryEvidenceAuthority, contextPolicy, compaction,processCapacity,hostControl,authorization,
  );
  registerScenarioRunMigrationRoutes(app,new ScenarioRunMigrationControl(sqlite,scenarioPackages,contextStore,
    new SqliteWorkerCheckpointStore(sqlite,new JsonFileCheckpointStore(resolve(projectRoot,"data","worker-checkpoints"))),options.scenarioRunMigration,changes));
  registerAuthorizationUpgradeRoutes(app,new ScenarioAuthorizationUpgradeControl(sqlite,scenarioPackages,options.authorizationUpgrade));
  registerScenarioRunDisposalRoutes(app,new ScenarioRunDisposalControl(sqlite,options.runDisposalAuthorizer,changes));
  registerScenarioHistoryRoutes(app,new ScenarioHistoryControl(sqlite,options.historyArchiveAuthorizer));
  const publishControlEvents = (change: Extract<Parameters<Parameters<typeof changes.subscribe>[0]>[0], { kind: "run" }>) => {
    const run = readRunForensics(sqlite,change.runId);
    if (!run) return;
    const committed = change.eventTypes.length ? scenarioEvents.page(change.runId, change.revision - change.eventTypes.length, change.eventTypes.length, change.revision)
      .map(row => JSON.parse(row.payload_json) as import("@traceforge/orchestration-core").ScenarioEvent) : [];
    committed.forEach((event, index) => {
      const revision = change.revision - committed.length + index + 1;
      if (event.type === "work_approval_requested") {
        const turnId = `approval:${event.approval.id}`;
        agentEvents.append({
          method: "turn/started", runId: run.id, caseId: run.caseId, workId: event.workId, turnId, role: "system",
          createdAt: event.at, params: { agentInstanceId: "approval-gate", sourceRunRevision: revision, sourceGraphRevision: null },
        });
        agentEvents.append({
          method: "item/started", runId: run.id, caseId: run.caseId, workId: event.workId, turnId, role: "system",
          createdAt: event.at,
          params: { item: { type: "approval", id: event.approval.id, tool: event.approval.toolName, status: "pending", risk: event.approval.risk, reason: null } },
        });
        return;
      }
      if (event.type === "work_approval_resolved") {
        const row = sqlite.prepare(`SELECT tool_name, risk, status, resolution_reason FROM scenario_work_approvals WHERE id = ?`)
          .get(event.approvalId) as { tool_name: string; risk: "read_only" | "bounded_write" | "privileged" | "destructive"; status: "approved" | "rejected" | "cancelled"; resolution_reason: string | null } | undefined;
        if (!row) return;
        const turnId = `approval:${event.approvalId}`;
        agentEvents.append({
          method: "item/completed", runId: run.id, caseId: run.caseId, workId: event.workId, turnId, role: "system", createdAt: event.at,
          params: { item: { type: "approval", id: event.approvalId, tool: row.tool_name, status: row.status, risk: row.risk, reason: row.resolution_reason } },
        });
        agentEvents.append({
          method: "turn/completed", runId: run.id, caseId: run.caseId, workId: event.workId, turnId, role: "system", createdAt: event.at,
          params: { status: row.status === "cancelled" ? "cancelled" : "completed", outcome: row.status === "approved" ? "continue" : "blocked", checkpointRef: null, error: null },
        });
        return;
      }
      if (event.type === "work_cancelled" || event.type === "run_cancelled") {
        const cancelledApprovals = (event.type === "work_cancelled"
          ? sqlite.prepare(`
              SELECT id, work_id, tool_name, risk, resolution_reason
              FROM scenario_work_approvals
              WHERE run_id = ? AND work_id = ? AND status = 'cancelled' AND resolved_at = ?
            `).all(run.id, event.workId, event.at)
          : sqlite.prepare(`
              SELECT id, work_id, tool_name, risk, resolution_reason
              FROM scenario_work_approvals
              WHERE run_id = ? AND status = 'cancelled' AND resolved_at = ?
            `).all(run.id, event.at)) as Array<{
              id: string; work_id: string; tool_name: string;
              risk: "read_only" | "bounded_write" | "privileged" | "destructive";
              resolution_reason: string | null;
            }>;
        for (const approval of cancelledApprovals) {
          const turnId = `approval:${approval.id}`;
          agentEvents.append({
            method: "item/completed", runId: run.id, caseId: run.caseId, workId: approval.work_id, turnId, role: "system", createdAt: event.at,
            params: { item: { type: "approval", id: approval.id, tool: approval.tool_name, status: "cancelled", risk: approval.risk, reason: approval.resolution_reason } },
          });
          agentEvents.append({
            method: "turn/completed", runId: run.id, caseId: run.caseId, workId: approval.work_id, turnId, role: "system", createdAt: event.at,
            params: { status: "cancelled", outcome: "blocked", checkpointRef: null, error: null },
          });
        }
      }
    });
  };
  const synchronizeAudit = () => {
    try { agentEvents.reconcileFromProjections(snapshotRecoveryCutoff); auditProjection.synchronize(); }
    catch (error) { auditProjection.markDelayed(); app.log.warn({ error }, "Agent audit projection delayed; durable sources retained"); }
  };
  const unsubscribeChanges = changes.subscribe((change) => {
    if (change.kind === "run") {
      try { publishControlEvents(change); }
      catch (error) { app.log.warn({ error }, "Approval event publication delayed; projection recovery required"); }
      synchronizeAudit();
    }
    if (change.kind === "run" && (change.eventTypes.includes("run_cancelled") || change.eventTypes.includes("run_paused"))) {
      modelRuntime.cancelRun(change.runId, change.eventTypes.includes("run_paused")
        ? "Run paused by the control plane"
        : "Run cancelled by the control plane");
    } else if (change.kind === "run" && change.eventTypes.includes("work_cancelled")) {
      const run = scenarioRuntime.load(change.runId);
      for (const work of run?.workItems ?? []) {
        if (work.status === "cancelled") modelRuntime.cancelWork(change.runId, work.id, "Work cancelled by the control plane");
      }
    }
    observer.wake();
    planner.wake();
  });
  const recoveryReport = runRecovery.recoverAll(new Date().toISOString());
  synchronizeAudit();
  const auditTimer = setInterval(synchronizeAudit, 1_000);
  auditTimer.unref();
  if (recoveryReport.actions.length || recoveryReport.issues.length) {
    app.log.info({ recoveryReport }, "Scenario Run startup recovery completed");
  }
  let cognitiveAgentsStarted = false;
  let listening = false;
  const startCognitiveAgents = () => {
    if (!listening || cognitiveAgentsStarted || !providerReady()) return;
    observer.start();
    planner.start();
    cognitiveAgentsStarted = true;
  };
  const readinessTimer = setInterval(startCognitiveAgents, 1_000);
  readinessTimer.unref();
  app.addHook("onListen", () => { listening = true; startCognitiveAgents(); });
  app.addHook("onClose", async () => {
    listening = false;
    unsubscribeChanges();
    clearInterval(readinessTimer);
    clearInterval(auditTimer);
    modelRuntime.shutdown();
    await observer.stop();
    await planner.stop();
  });
}
