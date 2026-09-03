import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalExecutionNode, NodeSpawnProcessLauncher, permissionProfileFingerprint, resourceLimitsFingerprint } from "@traceforge/execution-node";
import type { EffectivePermissionProfile, ScenarioDefinition } from "@traceforge/orchestration-core";
import { SCENARIO_PROCESS_HOST_CAPABILITIES, SCENARIO_PROCESS_PROTOCOL, ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { ToolProviderFairScheduler, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { GovernedExecutionSources } from "./governed-execution-sources.js";
import { SqliteScenarioProcessSupervisionStore } from "./scenario-process-supervision.js";
import { database } from "./test-fixtures/execution-recovery.js";
import { ProcessExecutionCapacity } from "./process-execution-capacity.js";

const definition: ScenarioDefinition = {
  kind: "fixture.process", version: 1, title: "Process fixture", authorizationActions: [], requiredCapabilities: [],
  workKinds: [{ id: "fixture.observe", defaultWorkerRoles: ["fixture.worker"] }], initialPhaseId: "fixture.phase",
  phases: [{ id: "fixture.phase", title: "Phase", objective: "Observe a neutral candidate", allowedWorkKinds: ["fixture.observe"],
    maxParallelWork: 1, requiredCapabilities: [], transitions: [] }],
  agentTopology: { planner: { enabled: false, pollIntervalMs: 1000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1, maximumProposalsPerEvaluation: 1 },
    observer: { enabled: false, pollIntervalMs: 1000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1 },
    workerPools: [{ id: "fixture.pool", role: "fixture.worker", workKinds: ["fixture.observe"], activation: "on_demand",
      minimumInstances: 0, maximumInstances: 1, maxConcurrentWork: 1, capabilities: [] }] },
};

describe("Scenario Process production assembly", () => {
  it("uses the child-process form and brokers only Host-owned state access", async () => {
    let trusted = true;
    const registry = new ScenarioPackageRegistry([{ id: "fixture.process-package", version: "1.0.0", schemaRevision: 1,
      definition, outputSchemas: [], authorizationPolicy: { format: "traceforge.scenario-scope-policy.v1",
        allowedActions: [], deniedActions: [], payload: { maximumBytes: 1024, maximumDepth: 4 }, resources: [] },
      runtime: { protocol: SCENARIO_PROCESS_PROTOCOL, protocolVersion: 1, id: "fixture.process-package", version: "1.0.0",
        source: "scenario:fixture.process-package", entrypoint: "package://runtime/main.mjs", providedCapabilities: ["fixture.observe"],
        hostCapabilities: [SCENARIO_PROCESS_HOST_CAPABILITIES.state] } }], () => { if (!trusted) throw new Error("Package review revoked"); });
    let stateOwner: unknown,stateReads=0;
    const sqlite=database(),supervision=new SqliteScenarioProcessSupervisionStore(sqlite);supervision.recoverInterrupted();
    const capacity=new ProcessExecutionCapacity(sqlite,new ToolProviderFairScheduler({global:4,perProvider:4,perTool:4,perRun:4,perWork:4}));
    const platform:EffectivePermissionProfile["platform"]=process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux";
    const permissions:EffectivePermissionProfile={version:1,platform,filesystem:{read:[{path:dirname(process.execPath),scope:"tree"},{path:resolve("."),scope:"tree"}],write:[],deny:[]},
      network:"deny",process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:["fixture"]};
    const resources={cpuTimeMs:60_000,memoryBytes:256*1024*1024,maximumProcesses:2,writeBytes:1024*1024};
    const node=new LocalExecutionNode(new NodeSpawnProcessLauncher(request=>({executable:request.executable,arguments:request.arguments,
      workingDirectory:request.workingDirectory,environment:request.environment,detached:false,windowsHide:true,enforcement:{sandboxBackend:"attested-neutral-fixture",
        sandboxed:true,filesystemPolicyApplied:true,permissionProfileFingerprint:permissionProfileFingerprint(request.permissions),resourceLimitsApplied:true,
        resourceLimitsFingerprint:resourceLimitsFingerprint(request.resources),network:"deny"}})),{platform,sandboxBackends:["attested-neutral-fixture"],
      maximumOutputBytesPerProcess:64*1024*1024,capabilities:{process:{spawn:true,stdio:true,tty:false,adoption:true,resourceLimits:true,signals:["interrupt","terminate","kill"]}}});
    const hostContext={
      authorization: { requireAction() { throw new Error("not used"); }, authorizeResource() { throw new Error("not used"); } },
      evidence: { recordNode() { throw new Error("not used"); } },
      artifacts: { record() { throw new Error("not used"); }, get() { return undefined; }, list() { return []; } },
      state: { read(input:any) { stateReads++;stateOwner = input; return { ...input, revision: 1, value: { offset: 1 }, updatedAt: "2026-09-02T00:00:00.000Z" }; },
        compareAndSet() { throw new Error("not used"); } },
      capabilities: { optional() { return undefined; }, require() { throw new Error("not used"); } },
    };
    const launches={ "scenario:fixture.process-package": { executable: process.execPath,
      arguments: [resolve("apps/server/test-fixtures/scenario-process.mjs")], workingDirectory: resolve("."),
      attribution:{caseId:"foundation",runId:"scenario-services",workId:"fixture.process-package",workerId:"scenario-process-host",scopeRef:"fixture-scope",
        leaseId:"fixture-service",leaseExpiresAt:"2100-01-01T00:00:00.000Z",actionId:"scenario-process.start",idempotencyKey:"scenario-process:fixture.process-package"},
      permissions,resources,expectedSandboxBackend:"attested-neutral-fixture" } };
    const governed = new GovernedExecutionSources(node,capacity,supervision);
    const [source] = governed.scenarioSources(registry,hostContext,{},launches);
    const [tool] = await source.discover();
    const context: ToolExecutionContext = { workerId: "worker", caseId: "case", runId: "run", workId: "work", scopeRef: "scope",
      leaseId: "lease", leaseExpiresAt: "2100-01-01T00:00:00.000Z", idempotencyKey: "effect",
      effectivePermissions: { version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "deny",
        process: { access: "deny", interactive: false, background: false }, secrets: "handles_only", sources: ["test"] } };
    await expect(tool.execute({}, context)).resolves.toMatchObject({ status: "succeeded", summary: "Scenario capability completed" });
    expect(stateOwner).toEqual({ packageId: "fixture.process-package", packageVersion: "1.0.0", caseId: "case", runId: "run", key: "cursor" });
    expect(governed.diagnostics()).toContainEqual({ source: "scenario:fixture.process-package", version: "1.0.0",
      process: "governed", origin: "scenario_process" });
    await source.close?.();
    expect(supervision.snapshot(registry.list()[0]!.runtime!)).toMatchObject({lastGeneration:1,state:"exited"});
    const restartedStore=new SqliteScenarioProcessSupervisionStore(sqlite);expect(restartedStore.recoverInterrupted()).toBe(0);
    const restartedGoverned=new GovernedExecutionSources(node,capacity,restartedStore);
    const [restartedSource]=restartedGoverned.scenarioSources(registry,hostContext,{},launches);
    const [restartedTool]=await restartedSource.discover();
    await expect(restartedTool.execute({},context)).resolves.toMatchObject({status:"succeeded"});
    expect(stateReads).toBe(1);expect(restartedStore.snapshot(registry.list()[0]!.runtime!)).toMatchObject({lastGeneration:2,state:"ready"});
    trusted = false;
    await expect(restartedTool.execute({}, context)).rejects.toThrow(/review revoked/);
    await restartedSource.close?.();
    expect(capacity.list("foundation","scenario-services").items).toHaveLength(2);
    expect(capacity.list("foundation","scenario-services").items.every(item=>item.state==="terminal_observed")).toBe(true);
    sqlite.close();
  });
});
