import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalExecutionNode,
  NodeSpawnProcessLauncher,
  permissionProfileFingerprint,
  resourceLimitsFingerprint,
  type ExecutionNode,
  type ProcessExecutionJournal,
  type StartProcessResponse,
} from "@traceforge/execution-node";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import {
  createProviderCapabilityHost,
  ToolProviderFairScheduler,
  type ProviderCapabilityHost,
  type ToolExecutionContext,
  type ToolProviderRecoverySnapshot,
} from "@traceforge/worker-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { createManagedToolProviderSourceFactory } from "./managed-tool-provider-source.js";
import { SqliteProviderCapabilityReceiptStore } from "./provider-capability-adapters.js";
import type { ToolProviderInstallation } from "./tool-provider-control-plane.js";
import { SqliteToolProviderRecoveryStateStore } from "./tool-provider-recovery-adapter.js";
import { ManagedExecutionCapacity } from "./managed-execution-capacity.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import { initialize, at } from "./test-fixtures/execution-recovery.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installation(): ToolProviderInstallation {
  return {
    manifest: {
      schemaVersion: 1,
      providerId: "provider.fixture",
      source: "fixture.source",
      version: "1.0.0",
      protocolVersion: 1,
      entrypoint: { executable: "provider", arguments: [], workingDirectory: "." },
      artifact: { sha256: "fixture", packageSha256: "fixture" },
      capabilities: [],
      tools: [],
      permissions: { network: "deny", filesystem: "none", process: "sandboxed", secrets: "none" },
      resources: { cpuTimeMs: 1, memoryBytes: 1, maximumProcesses: 1, maximumWriteBytes: 1 },
      platforms: ["linux"],
    },
    packageRoot: "/unused",
    manifestFingerprint: "fixture",
    signerId: "fixture",
    signature: { algorithm: "ed25519", keyId: "fixture", value: "fixture" },
    state: "enabled",
    stateReason: null,
    installedAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function workRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "traceforge-provider-source-"));
  temporaryRoots.push(root);
  return root;
}

const platform: EffectivePermissionProfile["platform"] = process.platform === "win32"
  ? "windows" : process.platform === "darwin" ? "darwin" : "linux";

function attestedFixtureNode(onLaunch: () => void = () => undefined, processJournal?:ProcessExecutionJournal): ExecutionNode {
  const launcher = new NodeSpawnProcessLauncher((request) => {
    onLaunch();
    return {
      executable: request.executable,
      arguments: request.arguments,
      workingDirectory: request.workingDirectory,
      environment: request.environment,
      detached: false,
      windowsHide: true,
      enforcement: {
        sandboxBackend: "attested-neutral-fixture",
        sandboxed: true,
        filesystemPolicyApplied: true,
        permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
        resourceLimitsApplied: true,
        resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources),
        network: request.permissions.network,
      },
    };
  });
  return new LocalExecutionNode(launcher, {
    processJournal,
    platform,
    sandboxBackends: ["attested-neutral-fixture"],
    maximumOutputBytesPerProcess: 64 * 1024 * 1024,
    capabilities: {
      process: {
        spawn: true,
        stdio: true,
        tty: false,
        adoption: true,
        resourceLimits: true,
        signals: ["interrupt", "terminate", "kill"],
      },
    },
  });
}

function executableInstallation(): ToolProviderInstallation {
  const packageRoot = dirname(process.execPath);
  const fixture = fileURLToPath(new URL("../../../packages/worker-runtime/test-fixtures/tool-provider.mjs", import.meta.url));
  return {
    ...installation(),
    packageRoot,
    manifest: {
      ...installation().manifest,
      providerId: "fixture",
      source: "rpc:test",
      entrypoint: { executable: basename(process.execPath), arguments: [fixture], workingDirectory: "." },
      capabilities: ["fixture.read"],
      tools: [{
        name: "fixture.read",
        source: "rpc:test",
        version: "1.0.0",
        priority: 100,
        description: "Read fixture input",
        inputSchema: { type: "object" },
        providedCapabilities: ["fixture.read"],
        dependencyCapabilities: [],
        permissionRequirements: {},
        risk: "read_only",
        timeoutMs: 5_000,
      }],
      resources: {
        cpuTimeMs: 60_000,
        memoryBytes: 128 * 1024 * 1024,
        maximumProcesses: 2,
        maximumWriteBytes: 1024 * 1024,
      },
      platforms: [platform],
    },
  };
}

function capabilityHost(
  sqlite: ReturnType<typeof getSqliteClient>,
  execute: () => void,
  authorize: () => void = () => undefined,
) {
  return createProviderCapabilityHost({
    handlers: [{
      capability: "fixture.lookup",
      async execute() {
        execute();
        return { output: { state: "available" }, refs: ["evidence:first"] };
      },
    }],
    policies: [{
      capability: "fixture.lookup",
      actions: ["fixture.inspect"],
      permissionRequirements: {},
      risk: "read_only",
    }],
    receipts: new SqliteProviderCapabilityReceiptStore(sqlite),
    scopes: {
      async authorize() {
        authorize();
        return { decision: "approved", authorizationRef: "scope-authorization-1" };
      },
    },
    approvals: { async authorize() { return { decision: "approved" }; } },
  })!;
}

describe("managed Tool Provider capability composition", () => {
  it.each(["normal","cancel","cleanup-failure","storage-refusal"])("accounts for managed Provider capacity after %s",async(mode)=>{
    const root=workRoot(),sqlite=getSqliteClient(createDb(join(root,"occupancy.sqlite"))),c=initialize(sqlite);
    const scheduler=new ToolProviderFairScheduler({global:1,maximumWaitMs:20});
    const capacity=new ManagedExecutionCapacity(sqlite,scheduler,c.bindings);
    const controller=new AbortController();
    const journal=new SqliteProcessExecutionJournal(sqlite);let launches=0,started:StartProcessResponse|undefined;
    const rawNode=attestedFixtureNode(()=>{launches++;},journal);
    const node=new Proxy(rawNode,{get(target,key){
      if(key==="startProcess")return async(request:Parameters<ExecutionNode["startProcess"]>[0])=>{started=await target.startProcess(request);if(mode==="cancel")controller.abort();return started;};
      if(key==="terminateProcess"&&mode==="cleanup-failure")return async()=>{throw new Error("injected cleanup unavailable");};
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});
    const source=createManagedToolProviderSourceFactory(node,join(root,"work"),undefined,{state:new SqliteToolProviderRecoveryStateStore(sqlite),scheduler,capacity})(executableInstallation());
    const [tool]=await source.discover();
    await c.bindings.prepare({idempotencyKey:"call",invocationId:"first",tool:{name:tool!.name,source:tool!.source,version:tool!.version,contractFingerprint:"a".repeat(64)},inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
    await c.bindings.beginExecution("call","lease","worker");
    if(mode==="storage-refusal")sqlite.exec("CREATE TRIGGER refuse_occupancy BEFORE INSERT ON managed_execution_occupancy BEGIN SELECT RAISE(ABORT,'injected storage refusal'); END");
    const context={caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",leaseExpiresAt:"2099-01-01T00:00:00.000Z",idempotencyKey:"call",effectivePermissions:{},signal:controller.signal} as ToolExecutionContext;
    try{
      const execution=tool!.execute(mode==="cancel"?{delayMs:2000}:{candidate:"first"},context);
      if(mode==="storage-refusal"){
        await expect(execution).rejects.toMatchObject({countsTowardProviderRecovery:false});
        expect(launches).toBe(0);expect(scheduler.snapshot()).toMatchObject({active:0,retained:0,occupied:0});
        expect(source.diagnostics?.()).toMatchObject({recovery:{status:"healthy",failures:[]}});return;
      }
      if(mode==="normal")expect((await execution).status).toBe("succeeded");
      else await expect(execution).rejects.toThrow();
      expect(launches).toBe(1);expect(scheduler.snapshot()).toMatchObject({active:0,retained:1,occupied:1});
      expect(capacity.inspect("call").externallyOccupied).toBe(true);
      const restored=new ManagedExecutionCapacity(sqlite,new ToolProviderFairScheduler({global:1}),c.bindings);
      expect(restored.scheduler.snapshot().retained).toBe(1);
    }finally{
      if(started&&mode==="cleanup-failure"){
        const access={processId:started.process.id,adoptionToken:started.adoptionToken};let descriptor=await rawNode.terminateProcess({...access,force:true});
        const until=Date.now()+3000;while(!["exited","failed"].includes(descriptor.state)&&Date.now()<until)descriptor=(await rawNode.waitProcessEvents({...access,afterSequence:descriptor.lastEventSequence,maximumEvents:256},100)).process;
        expect(["exited","failed"]).toContain(descriptor.state);
      }
      sqlite.close();
    }
  });
  it("reports the capability host as disabled by default and enabled only when explicitly injected", () => {
    const node = {} as ExecutionNode;
    const withoutHost = createManagedToolProviderSourceFactory(node, workRoot())(installation());
    const withHost = createManagedToolProviderSourceFactory(
      node,
      workRoot(),
      {} as ProviderCapabilityHost,
    )(installation());

    expect(withoutHost.diagnostics?.()).toMatchObject({ providerCapabilityHost: "disabled" });
    expect(withHost.diagnostics?.()).toMatchObject({ providerCapabilityHost: "enabled" });
  });

  it("runs a neutral reverse capability through the production composition and replays its SQLite Receipt after restart", async () => {
    const directory = workRoot();
    const databasePath = join(directory, "runtime.sqlite");
    const providerWorkRoot = join(directory, "provider-work");
    const context: ToolExecutionContext = {
      workerId: "worker-1",
      runId: "run-1",
      workId: "work-1",
      caseId: "case-1",
      scopeRef: "scope-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2100-01-01T00:00:00.000Z",
      idempotencyKey: "tool-effect-1",
      effectivePermissions: {
        version: 1,
        platform,
        filesystem: { read: [], write: [], deny: [] },
        network: "deny" as const,
        process: { access: "sandboxed" as const, interactive: false, background: false },
        secrets: "deny" as const,
        sources: ["neutral-fixture"],
      },
    };
    let executions = 0;
    let authorizations = 0;
    let sqlite = getSqliteClient(createDb(databasePath));
    const firstSource = createManagedToolProviderSourceFactory(
      attestedFixtureNode(),
      providerWorkRoot,
      capabilityHost(sqlite, () => { executions += 1; }, () => { authorizations += 1; }),
    )(executableInstallation());
    const [firstTool] = await firstSource.discover();
    const first = await firstTool!.execute({ broker: true }, context);
    expect(first).toMatchObject({
      status: "succeeded",
      summary: "fixture host capability succeeded",
      refs: ["host:succeeded"],
    });
    const firstReceipt = JSON.parse(first.raw) as { status: string; replayed?: boolean };
    expect(firstReceipt).toMatchObject({ status: "succeeded" });
    expect(firstReceipt.replayed).toBeUndefined();
    expect(executions).toBe(1);
    expect(authorizations).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM provider_capability_receipts").get()).toEqual({ count: 1 });
    sqlite.close();

    sqlite = getSqliteClient(createDb(databasePath));
    const recoveredSource = createManagedToolProviderSourceFactory(
      attestedFixtureNode(),
      providerWorkRoot,
      capabilityHost(sqlite, () => { executions += 1; }, () => { authorizations += 1; }),
    )(executableInstallation());
    const [recoveredTool] = await recoveredSource.discover();
    const replayed = await recoveredTool!.execute({ broker: true }, context);
    expect(replayed).toMatchObject({ status: "succeeded", summary: "fixture host capability succeeded" });
    expect(JSON.parse(replayed.raw)).toMatchObject({ status: "succeeded", replayed: true });
    expect(executions).toBe(1);
    expect(authorizations).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM provider_capability_receipts").get()).toEqual({ count: 1 });
    sqlite.close();
  });

  it("cancels an active invocation, releases its scheduling slot, and preserves Provider health", async () => {
    const directory = workRoot();
    const sqlite = getSqliteClient(createDb(join(directory, "cancellation.sqlite")));
    const scheduler = new ToolProviderFairScheduler({ global: 1, perProvider: 1, perTool: 1, perRun: 1, perWork: 1 });
    const source = createManagedToolProviderSourceFactory(
      attestedFixtureNode(),
      join(directory, "provider-cancellation-work"),
      undefined,
      { state: new SqliteToolProviderRecoveryStateStore(sqlite), scheduler },
    )(executableInstallation());
    const [tool] = await source.discover();
    const cancellation = new AbortController();
    const cancellableContext: ToolExecutionContext = {
      workerId: "worker-cancel", runId: "run-cancel", workId: "work-cancel", caseId: "case-cancel",
      scopeRef: "scope-cancel", leaseId: "lease-cancel", leaseExpiresAt: "2100-01-01T00:00:00.000Z",
      idempotencyKey: "effect-cancel",
      effectivePermissions: {
        version: 1, platform, filesystem: { read: [], write: [], deny: [] }, network: "deny",
        process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny", sources: ["neutral-fixture"],
      },
      signal: cancellation.signal,
    };
    const execution = tool!.execute({ delayMs: 2_000 }, cancellableContext);
    await new Promise((resolve) => setTimeout(resolve, 25));
    cancellation.abort();
    await expect(execution).rejects.toMatchObject({ reason: "cancelled", countsTowardProviderRecovery: false });
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 });
    const diagnostics = source.diagnostics?.();
    expect(diagnostics).toMatchObject({
      recovery: { status: "healthy", failures: [] },
      scheduling: { status: "enabled", active: 0, queued: 0, limits: { perWork: 1 } },
    });
    expect(JSON.stringify(diagnostics)).not.toContain("run-cancel");
    expect(JSON.stringify(diagnostics)).not.toContain("work-cancel");
    sqlite.close();
  });

  it("blocks process launches during backoff and projects a sticky quarantine after the failure budget", async () => {
    const directory = workRoot();
    const sqlite = getSqliteClient(createDb(join(directory, "recovery.sqlite")));
    const state = new SqliteToolProviderRecoveryStateStore(sqlite);
    let current = new Date("2026-08-29T01:00:00.000Z");
    let launches = 0;
    const quarantined: ToolProviderRecoverySnapshot[] = [];
    const source = createManagedToolProviderSourceFactory(
      attestedFixtureNode(() => { launches += 1; }),
      join(directory, "provider-recovery-work"),
      undefined,
      {
        state,
        baseDelayMs: 1_000,
        maximumDelayMs: 8_000,
        failureBudget: 2,
        failureWindowMs: 60_000,
        stabilityWindowMs: 10_000,
        jitterRatio: 0,
        now: () => current,
        onQuarantined: (snapshot) => { quarantined.push(snapshot); },
      },
    )(executableInstallation());
    const [tool] = await source.discover();
    const baseContext: ToolExecutionContext = {
      workerId: "worker-1", runId: "run-1", workId: "work-1", caseId: "case-1", scopeRef: "scope-1",
      leaseId: "lease-1", leaseExpiresAt: "2100-01-01T00:00:00.000Z", idempotencyKey: "effect-1",
      effectivePermissions: {
        version: 1, platform, filesystem: { read: [], write: [], deny: [] }, network: "deny",
        process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny", sources: ["neutral-fixture"],
      },
    };

    await expect(tool!.execute({ crash: true }, baseContext)).rejects.toThrow(/exited with code 9/);
    expect(launches).toBe(1);
    await expect(tool!.execute({}, { ...baseContext, idempotencyKey: "effect-2" })).resolves.toMatchObject({
      status: "failed", retryable: true, summary: expect.stringContaining("recovery backoff until"),
    });
    expect(launches).toBe(1);

    current = new Date(current.getTime() + 1_000);
    await expect(tool!.execute({ crash: true }, { ...baseContext, idempotencyKey: "effect-3" })).resolves.toMatchObject({
      status: "failed", retryable: false, summary: expect.stringContaining("Failure budget 2 exhausted"),
    });
    expect(launches).toBe(2);
    expect(quarantined).toHaveLength(1);
    await expect(tool!.execute({}, { ...baseContext, idempotencyKey: "effect-4" })).resolves.toMatchObject({
      status: "failed", retryable: false,
    });
    expect(launches).toBe(2);
    await expect(state.load({ providerId: "fixture", version: "1.0.0" })).resolves.toMatchObject({ status: "quarantined" });
    sqlite.close();
  });
});
