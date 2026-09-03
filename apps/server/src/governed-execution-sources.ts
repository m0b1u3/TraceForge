import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExecutionNode, BrokeredHttpRequest } from "@traceforge/execution-node";
import type { ScenarioPackageRegistry, ScenarioToolHostContext } from "@traceforge/scenario-sdk";
import { waitForCancellation, type ExecutionSourcePolicy, type ExecutionToolDiscoverySource,
  ScenarioProcessRuntime, type ScenarioProcessLaunch, type GovernedExecutionPort, type GovernedExecutionSourceRegistration, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { ExecutionNodeProcessTool } from "./worker-execution-adapters.js";
import type { ProcessCapacityInput, ProcessExecutionCapacity } from "./process-execution-capacity.js";
import type { ToolProviderInstallation } from "./tool-provider-control-plane.js";
import { createScenarioProcessCapabilityHandlers } from "./scenario-process-capabilities.js";
import type { SqliteScenarioProcessSupervisionStore } from "./scenario-process-supervision.js";
import type { ExecutionSessionGateway } from "./execution-session-gateway.js";
import type { SqliteScenarioTrafficStore } from "./scenario-traffic-store.js";

interface Scope {
  token: object;
  identity: Omit<ProcessCapacityInput, "attribution">;
  context?: ToolExecutionContext;
  controller: AbortController;
  open: boolean;
  pending: Set<Promise<unknown>>;
  errors: unknown[];
  deadlineAt: number;
  authorize?: () => void;
}

/** Controls host-supplied ports. This is NOT isolation from arbitrary in-process JS imports. */
export class GovernedExecutionSources {
  private readonly scopes = new AsyncLocalStorage<Scope>();
  private readonly coverage = new Map<string,{ source: string; version: string; process: string; origin: string }>();
  private readonly scenarioProcesses = new Map<string, ScenarioProcessRuntime>();

  constructor(private readonly node: ExecutionNode | undefined, private readonly capacity: ProcessExecutionCapacity,
    private readonly scenarioSupervision?: SqliteScenarioProcessSupervisionStore) {}

  diagnostics() { return [...this.coverage.values()].map(item => ({ ...item })); }

  revokeScenarioPackage(id: string, version: string, reason: string): void {
    const runtime = this.scenarioProcesses.get(`${id}\u0000${version}`);
    if (runtime) void runtime.revoke(reason).catch(() => undefined);
  }

  register(registration: GovernedExecutionSourceRegistration): ExecutionToolDiscoverySource {
    const policy = this.policy(registration), source = validText(registration.source);
    const token = Object.freeze({});
    const adapter = registration.create(this.port(token, policy));
    if (adapter.source !== source) throw new Error("Governed source factory identity mismatch");
    return this.wrap(adapter, policy, token, "custom");
  }

  async registerProvider(installation: ToolProviderInstallation,
    factory: (installation: ToolProviderInstallation) => Promise<GovernedExecutionSourceRegistration> | GovernedExecutionSourceRegistration) {
    // A host factory receives a copy; its mutation must not rewrite the signed installation identity.
    const source=installation.manifest.source,version=installation.manifest.version;
    const registration=await factory(structuredClone(installation));
    if(registration.source!==source || registration.version!==version)throw new Error("Governed provider installation identity mismatch");
    return this.register(registration);
  }

  scenarioSources(registry: ScenarioPackageRegistry, context: Omit<ScenarioToolHostContext,"execution">,
    policies: Readonly<Record<string, ExecutionSourcePolicy>> = {},
    launches: Readonly<Record<string, ScenarioProcessLaunch>> = {},
    allowInProcessDevelopment = false,
    processServices: {sessions?:ExecutionSessionGateway;traffic?:SqliteScenarioTrafficStore} = {}): ExecutionToolDiscoverySource[] {
    const sources: ExecutionToolDiscoverySource[] = [], seen = new Set<string>(), consumed = new Set<string>(), consumedLaunches = new Set<string>();let quarantined=false;
    for (const installation of registry.list()) {
      if(registry.bindingStatus(registry.bindingFor(installation),installation.definition.kind,installation.definition.version).status!=="available"){quarantined=true;continue;}
      if (installation.runtime) {
        if (seen.has(installation.runtime.source)) throw new Error("Duplicate Scenario execution source");
        seen.add(installation.runtime.source);
        const launch = launches[installation.runtime.source];
        if (!launch) throw new Error(`Scenario Process ${installation.runtime.source} requires trusted Host launch material`);
        if (!("attribution" in launch) || !this.node || !this.scenarioSupervision) {
          throw new Error(`Scenario Process ${installation.runtime.source} requires Execution Node and durable supervision`);
        }
        consumedLaunches.add(installation.runtime.source);
        const declared = Object.hasOwn(policies, installation.runtime.source) ? policies[installation.runtime.source] : undefined;
        if (declared) {
          consumed.add(installation.runtime.source);
          const policy = this.policy(declared);
          if (policy.version !== installation.version || policy.process !== "governed") throw new Error("Scenario Process policy identity mismatch");
        }
        const runtime = new ScenarioProcessRuntime({ manifest: installation.runtime, launch,
          capabilityHandlers: createScenarioProcessCapabilityHandlers(installation, context, undefined, this.node,processServices.sessions,processServices.traffic)
            .filter((handler) => installation.runtime!.hostCapabilities.includes(handler.capability)),
          transport: { allowUnsandboxedDevelopment: false }, assertAvailable: () => registry.assertAvailable(installation),
          scheduler: this.capacity.scheduler, executionNode: this.node, supervision: this.scenarioSupervision,
          processCapacity:{acquire:(generation,attribution)=>this.capacity.acquire({source:installation.runtime!.source,
            version:installation.version,operation:`scenario-process:generation:${generation}`,kind:"service",attribution})} });
        this.scenarioProcesses.set(`${installation.id}\u0000${installation.version}`, runtime);
        this.coverage.set(runtime.source, { source: runtime.source, version: installation.version,
          process: "governed", origin: "scenario_process" });
        sources.push(runtime);
        continue;
      }
      if (!allowInProcessDevelopment) {
        throw new Error(`Scenario Package ${installation.id}@${installation.version} cannot execute in the trusted Host; declare a Scenario Process runtime`);
      }
      const token = Object.freeze({});
      // Policy is selected by the active source scope, never by the package calling the port.
      const port = this.port(token);
      const adapters = installation.createToolSources!({ ...context, execution: port });
      for (const adapter of adapters) {
        if (seen.has(adapter.source)) throw new Error("Duplicate Scenario execution source");
        seen.add(adapter.source);
        const declared = Object.hasOwn(policies,adapter.source) ? policies[adapter.source] : undefined;
        if (declared) consumed.add(adapter.source);
        const policy = this.policy(declared ?? { version: installation.version, process: "denied" });
        const guarded:ExecutionToolDiscoverySource={...adapter,source:adapter.source,
          async discover(signal){registry.assertAvailable(installation);const tools=await adapter.discover(signal);registry.assertAvailable(installation);
            return tools.map(tool=>({...tool,execute(input,context){registry.assertAvailable(installation);return tool.execute(input,context);}}));},
          close:adapter.close?()=>adapter.close!():undefined,diagnostics:adapter.diagnostics?()=>adapter.diagnostics!():undefined};
        sources.push(this.wrap(guarded, policy, token, declared ? "scenario_declared" : "scenario_legacy_process_denied"));
      }
    }
    for (const source of Object.keys(policies)) if (!consumed.has(source) && !quarantined) throw new Error(`Unknown Scenario execution policy: ${source}`);
    for (const source of Object.keys(launches)) if (!consumedLaunches.has(source) && !quarantined) throw new Error(`Unknown Scenario Process launch material: ${source}`);
    return sources;
  }

  private policy(value: ExecutionSourcePolicy): ExecutionSourcePolicy {
    const version = validText(value.version);
    if (!["denied", "governed"].includes(value.process)) throw new Error("Explicit execution process policy required");
    if (value.process === "governed" && !this.node) throw new Error("Governed process source requires Execution Node");
    if (value.discoveryService && (value.process !== "governed" || typeof value.discoveryService.authorize !== "function")) {
      throw new Error("Discovery process requires governed host service authorization");
    }
    const service = value.discoveryService;
    if(service){
      for(const key of ["caseId","runId","workId","workerId","scopeRef","leaseId","idempotencyKey","actionId"] as const) validText(service.attribution[key]);
      if(!(Date.parse(service.attribution.leaseExpiresAt)>Date.now())) throw new Error("Discovery service scope expired");
    }
    return Object.freeze({ version, process: value.process, ...(service ? { discoveryService: {
      attribution: structuredClone(service.attribution), permissions: structuredClone(service.permissions), authorize: service.authorize.bind(service),
    } } : {}) });
  }

  private readonly policies = new WeakMap<Scope, ExecutionSourcePolicy>();

  private wrap(adapter: ExecutionToolDiscoverySource, policy: ExecutionSourcePolicy, token: object, origin: string): ExecutionToolDiscoverySource {
    const source = validText(adapter.source), live = new Set<Scope>();
    let closed = false;
    this.coverage.set(source,{ source, version: policy.version, process: policy.process, origin });
    const run = async <T>(operation: string, context: ToolExecutionContext | undefined, signal: AbortSignal | undefined,
      timeoutMs: number, action: (scope: Scope) => Promise<T>): Promise<T> => {
      if (closed) throw new Error("Execution source closed");
      if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>300_000) throw new Error("Invalid source operation deadline");
      signal?.throwIfAborted();
      const service = context ? undefined : policy.discoveryService;
      const frozenContext = context ? snapshotContext(context) : service ? {
        ...structuredClone(service.attribution), effectivePermissions: structuredClone(service.permissions),
      } : undefined;
      const scope: Scope = { token, identity: { source, version: policy.version, operation,
        kind: context ? "work" : "service", ...(context ? { parentInvocationKey: context.idempotencyKey } : {}) },
        context: frozenContext, controller: new AbortController(), open: true, pending: new Set(), errors: [], authorize: service?.authorize,
        deadlineAt: Math.min(Date.now()+timeoutMs,frozenContext ? Date.parse(frozenContext.leaseExpiresAt) : Infinity) };
      this.policies.set(scope, policy); live.add(scope);
      const cancel = () => scope.controller.abort(signal?.reason ?? new Error("Source operation cancelled"));
      signal?.addEventListener("abort", cancel, { once: true });
      if(signal?.aborted)cancel();
      const leaseMs = frozenContext ? Date.parse(frozenContext.leaseExpiresAt)-Date.now() : timeoutMs;
      const timer = setTimeout(() => scope.controller.abort(new Error("Source operation deadline exceeded")), Math.max(0,Math.min(timeoutMs,leaseMs)));
      try {
        return await this.scopes.run(scope, () => waitForCancellation(async () => {
          const result = await action(scope);
          // No detached host operations: wait for everything admitted before returning a result.
          while(scope.pending.size) await Promise.allSettled([...scope.pending]);
          if(scope.errors.length) throw scope.errors[0];
          return result;
        }, scope.controller.signal));
      } finally {
        scope.open = false;
        scope.controller.abort(new Error("Source operation finished"));
        live.delete(scope); clearTimeout(timer); signal?.removeEventListener("abort",cancel);
      }
    };
    return Object.freeze({ source,
      discover: (signal?: AbortSignal) => run("discover", undefined, signal, 15_000, async scope => {
        const tools = await adapter.discover(scope.controller.signal);
        return tools.map(tool => {
          if(tool.source!==source || tool.version!==policy.version) throw new Error("Governed tool identity/version mismatch");
          validText(tool.name);
          if(!Number.isFinite(tool.timeoutMs) || !Number.isSafeInteger(tool.timeoutMs) || tool.timeoutMs<1)throw new Error("Invalid source tool deadline");
          if(tool.permissionRequirements.process === "sandboxed" && policy.process === "denied") throw new Error("Tool process capability conflicts with source policy");
          const operation=tool.name, timeoutMs=Math.min(tool.timeoutMs,300_000), execute=tool.execute.bind(tool);
          return { ...tool, execute: (input: unknown, context: ToolExecutionContext) => run(operation,context,context.signal,timeoutMs,
            async active => execute(input,{...snapshotContext(active.context!),signal:active.controller.signal})) };
        });
      }),
      close: async () => {
        if(closed)return;closed=true;
        for(const scope of live)scope.controller.abort(new Error("Execution source closed"));
        await waitForCancellation(() => adapter.close?.() ?? Promise.resolve(),AbortSignal.timeout(5000));
      },
      diagnostics: () => ({ governance: { source, version: policy.version, process: policy.process, origin,
        port: "host_scoped", arbitraryJavaScriptIsolation: false, detachedProcesses: false } }),
    });
  }

  private scope(token: object): Scope {
    const scope = this.scopes.getStore();
    if(!scope || scope.token!==token || !scope.open)throw new Error("Execution port requires its active source operation");
    scope.controller.signal.throwIfAborted();
    if(!(scope.deadlineAt>Date.now()))throw new Error("Source operation deadline exceeded");
    return scope;
  }

  private dispatch(scope: Scope): ToolExecutionContext {
    this.scope(scope.token);
    if(!scope.context)throw new Error("Discovery has no authorized service execution scope");
    const authorization:unknown=scope.authorize?.();
    if(authorization!==undefined){
      // A Promise from an accidentally async callback must not silently authorize dispatch.
      void Promise.resolve(authorization).catch(()=>{});
      throw new Error("Service authorization must complete synchronously without a return value");
    }
    this.capacity.assertOwnership({ ...scope.identity, attribution: { ...scope.context, actionId: scope.context.idempotencyKey } });
    return scope.context;
  }

  private track<T>(scope: Scope, action: () => Promise<T>): Promise<T> {
    if(scope.pending.size>=64)throw new Error("Source operation pending limit exceeded");
    const task=Promise.resolve().then(action);
    scope.pending.add(task);
    void task.then(()=>scope.pending.delete(task),error=>{scope.pending.delete(task);scope.errors.push(error);});
    return task;
  }

  private port(token: object, registrationPolicy?: ExecutionSourcePolicy): GovernedExecutionPort {
    return Object.freeze({
      executeProcess: async (input: unknown) => {
        const scope=this.scope(token), policy=registrationPolicy ?? this.policies.get(scope)!;
        if(policy.process!=="governed")throw new Error("Source process execution denied");
        const context=this.dispatch(scope), snapshot=structuredClone(input);
        // A source cannot choose/reuse another invocation's process idempotency key.
        const child={...snapshotContext(context),idempotencyKey:`source-process:${randomUUID()}`,signal:scope.controller.signal};
        return this.track(scope,()=>new ExecutionNodeProcessTool(this.node!,this.capacity,scope.identity,
          ()=>{this.dispatch(scope);}).execute(snapshot,child));
      },
      requestHttp: async (input: Omit<BrokeredHttpRequest,"requestId"|"attribution"|"permissions">) => {
        const scope=this.scope(token), context=this.dispatch(scope);
        if(!this.node)throw new Error("Source HTTP requires Execution Node");
        const snapshot=structuredClone(input),key=`source-http:${randomUUID()}`;
        return this.track(scope,async()=>{
          this.dispatch(scope);
          const response=await this.node!.requestHttp({...snapshot,requestId:key,
            timeoutMs:Math.min(snapshot.timeoutMs,scope.deadlineAt-Date.now()),
            attribution:{...snapshotContext(context),idempotencyKey:key,actionId:key},permissions:structuredClone(context.effectivePermissions)});
          this.dispatch(scope);return response;
        });
      },
    });
  }

}

function validText(value: string): string {
  if(typeof value!=="string" || !value.trim() || value.trim()!==value || Buffer.byteLength(value)>256)throw new Error("Invalid execution source identity");
  return value;
}
function snapshotContext(context:ToolExecutionContext):ToolExecutionContext {
  return {caseId:context.caseId,runId:context.runId,workId:context.workId,workerId:context.workerId,scopeRef:context.scopeRef,
    leaseId:context.leaseId,leaseExpiresAt:context.leaseExpiresAt,idempotencyKey:context.idempotencyKey,
    effectivePermissions:structuredClone(context.effectivePermissions)};
}
