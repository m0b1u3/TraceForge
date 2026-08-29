import { CapabilityProviderRegistry, type CapabilityProviderState } from "@traceforge/tool-resolver";
import type { ExecutionToolSpec } from "./model.js";
import type { ExecutionToolAdapter } from "./tool-gateway.js";
import {
  executionToolCatalogFingerprint,
  snapshotToolSpec,
  type ExecutionToolDiscoverySnapshot,
  type ExecutionToolDiscoveryStatePort,
} from "./tool-discovery-state.js";

export interface ExecutionToolDiscoverySource {
  readonly source: string;
  discover(): Promise<ExecutionToolAdapter[]>;
  close?(): Promise<void>;
  diagnostics?(): Record<string, unknown>;
}

export interface ExecutionToolSourceStatus {
  source: string;
  status: "pending" | "ready" | "degraded";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  discoveredProviders: number;
  discoveryRevision: number;
  lastSuccessfulCatalogFingerprint: string | null;
  restoredFromPersistence: boolean;
  acceptingInvocations: boolean;
  inFlightInvocations: number;
  diagnostics: Record<string, unknown> | null;
}

export interface ExecutionToolProviderStatus {
  tool: ExecutionToolSpec;
  lifecycle: CapabilityProviderState<ExecutionToolAdapter>["lifecycle"];
  health: CapabilityProviderState<ExecutionToolAdapter>["health"];
  consecutiveFailures: number;
  lastFailure: string | null;
  revision: number;
}

export interface ExecutionToolRuntimeSnapshot {
  registryRevision: number;
  status: "initializing" | "ready" | "degraded";
  sources: ExecutionToolSourceStatus[];
  providers: ExecutionToolProviderStatus[];
}

export interface ExecutionToolSourceActivation {
  drained: Promise<void>;
}

interface MutableSourceStatus extends ExecutionToolSourceStatus {
  lastAttemptMs: number | null;
}

interface SourceGeneration {
  source: ExecutionToolDiscoverySource;
  accepting: boolean;
  inFlight: number;
  drained: Promise<void>;
  resolveDrained: () => void;
  closePromise: Promise<void> | null;
}

export class ExecutionToolDiscoveryRuntime {
  readonly registry: CapabilityProviderRegistry<ExecutionToolAdapter>;
  private readonly sources = new Map<string, ExecutionToolDiscoverySource>();
  private readonly generations = new Map<string, SourceGeneration>();
  private readonly sourceStatuses = new Map<string, MutableSourceStatus>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly retirements = new Set<Promise<void>>();
  private restorePromise: Promise<void> | undefined;
  private readonly sourceRestorations = new Map<string, Promise<ExecutionToolDiscoverySnapshot | undefined>>();

  constructor(
    sources: readonly ExecutionToolDiscoverySource[],
    private readonly refreshIntervalMs = 30_000,
    unavailableAfterFailures = 3,
    private readonly now: () => Date = () => new Date(),
    private readonly statePort?: ExecutionToolDiscoveryStatePort,
  ) {
    if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs < 0) throw new Error("Tool discovery refresh interval must be non-negative");
    this.registry = new CapabilityProviderRegistry<ExecutionToolAdapter>(unavailableAfterFailures);
    for (const source of sources) this.registerSource(source);
  }

  registerSource(source: ExecutionToolDiscoverySource): void {
    const id = source.source.trim();
    if (!id) throw new Error("Tool discovery source is required");
    if (this.sources.has(id)) throw new Error(`Tool discovery source already registered: ${id}`);
    this.sources.set(id, source);
    this.generations.set(id, createGeneration(source));
    this.sourceStatuses.set(id, {
      source: id, status: "pending", lastAttemptAt: null, lastSuccessAt: null, lastError: null,
      discoveredProviders: 0, acceptingInvocations: true, inFlightInvocations: 0,
      discoveryRevision: 0, lastSuccessfulCatalogFingerprint: null, restoredFromPersistence: false,
      diagnostics: null, lastAttemptMs: null,
    });
  }

  restore(): Promise<void> {
    if (!this.statePort) return Promise.resolve();
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = Promise.all([...this.sources.keys()].map((source) => this.restoreSource(source))).then(() => undefined);
    return this.restorePromise;
  }

  hasSource(source: string): boolean {
    return this.sources.has(source);
  }

  async activateSource(source: ExecutionToolDiscoverySource): Promise<ExecutionToolSourceActivation> {
    const id = source.source.trim();
    if (!id) throw new Error("Tool discovery source is required");
    const restored = await this.restoreSource(id);
    const current = this.sources.get(id);
    if (current === source) {
      await this.refresh(id);
      return { drained: Promise.resolve() };
    }
    const generation = createGeneration(source);
    const attemptedAt = this.now();
    const providers = await this.discover(source, generation);
    const previousGeneration = this.generations.get(id);
    const previousProviders = this.registry.list()
      .filter((state) => state.provider.source === id && state.lifecycle !== "retired")
      .map((state) => state.provider);
    if (previousGeneration) this.beginDrain(previousGeneration);
    this.registry.drainSource(id);
    let succeededAt = attemptedAt.toISOString();
    let revision = Math.max(this.sourceStatuses.get(id)?.discoveryRevision ?? 0, restored?.revision ?? 0) + 1;
    const catalog = providers.map(snapshotToolSpec);
    const catalogFingerprint = executionToolCatalogFingerprint(catalog);
    try {
      this.registry.synchronize(id, providers);
      succeededAt = this.now().toISOString();
      const currentState = this.sourceStatuses.get(id);
      revision = Math.max(currentState?.discoveryRevision ?? 0, restored?.revision ?? 0) + 1;
      await this.saveDiscovery({
        schemaVersion: 1, source: id, revision,
        outcome: "ready", lastAttemptAt: attemptedAt.toISOString(), lastSuccessAt: succeededAt,
        lastFailure: null, lastSuccessfulCatalog: catalog,
        catalogFingerprint, updatedAt: succeededAt,
      });
    } catch (error) {
      if (previousGeneration) this.resume(previousGeneration);
      this.registry.synchronize(id, previousProviders);
      throw error;
    }
    this.sources.set(id, source);
    this.generations.set(id, generation);
    this.sourceStatuses.set(id, {
      source: id, status: "ready", lastAttemptAt: attemptedAt.toISOString(), lastSuccessAt: succeededAt, lastError: null,
      discoveredProviders: providers.length, acceptingInvocations: true, inFlightInvocations: 0,
      discoveryRevision: revision,
      lastSuccessfulCatalogFingerprint: catalogFingerprint, restoredFromPersistence: false,
      diagnostics: source.diagnostics?.() ?? null, lastAttemptMs: attemptedAt.getTime(),
    });
    const drained = previousGeneration ? this.trackRetirement(this.closeGeneration(previousGeneration)) : Promise.resolve();
    return { drained };
  }

  async deactivateSource(source: string): Promise<void> {
    const current = this.sources.get(source);
    const generation = this.generations.get(source);
    this.registry.drainSource(source);
    if (!current) return;
    if (generation) await this.closeGeneration(generation);
    else await current.close?.();
    if (this.sources.get(source) === current) {
      this.sources.delete(source);
      this.generations.delete(source);
      this.sourceStatuses.delete(source);
    }
  }

  drainSource(source: string): string[] {
    const generation = this.generations.get(source);
    if (generation) this.beginDrain(generation);
    return this.registry.drainSource(source);
  }

  async refreshDue(): Promise<void> {
    const current = this.now().getTime();
    const due = [...this.sourceStatuses.values()]
      .filter((state) => this.generations.get(state.source)?.accepting !== false)
      .filter((state) => state.lastAttemptMs === null || current - state.lastAttemptMs >= this.refreshIntervalMs)
      .map((state) => state.source);
    await Promise.all(due.map((source) => this.refresh(source)));
  }

  async refresh(source?: string): Promise<void> {
    if (source) return this.refreshOne(source);
    await Promise.all([...this.sources.keys()].map((id) => this.refreshOne(id)));
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.refreshes.values()]);
    await Promise.all([
      ...[...this.generations.values()].map((generation) => this.closeGeneration(generation)),
      ...this.retirements,
    ]);
  }

  snapshot(): ExecutionToolRuntimeSnapshot {
    const sources = [...this.sourceStatuses.values()]
      .map(({ lastAttemptMs: _lastAttemptMs, ...state }) => {
        const generation = this.generations.get(state.source);
        return {
          ...state,
          acceptingInvocations: generation?.accepting ?? false,
          inFlightInvocations: generation?.inFlight ?? 0,
          diagnostics: this.sources.get(state.source)?.diagnostics?.() ?? state.diagnostics,
        };
      })
      .sort((left, right) => left.source.localeCompare(right.source));
    const providers = this.registry.list().map(({ provider, ...state }) => {
      const { execute: _execute, ...tool } = provider;
      return { tool, lifecycle: state.lifecycle, health: state.health, consecutiveFailures: state.consecutiveFailures, lastFailure: state.lastFailure, revision: state.revision };
    });
    return {
      registryRevision: Math.max(0, ...providers.map((provider) => provider.revision)),
      status: sources.some((source) => source.status === "degraded")
        ? "degraded"
        : sources.some((source) => source.status === "pending") ? "initializing" : "ready",
      sources,
      providers,
    };
  }

  private async refreshOne(source: string): Promise<void> {
    await this.restoreSource(source);
    const existing = this.refreshes.get(source);
    if (existing) return existing;
    if (this.generations.get(source)?.accepting === false) return;
    const discovered = this.sources.get(source);
    if (!discovered) throw new Error(`Unknown tool discovery source: ${source}`);
    const refresh = this.performRefresh(discovered).finally(() => { this.refreshes.delete(source); });
    this.refreshes.set(source, refresh);
    return refresh;
  }

  private async performRefresh(source: ExecutionToolDiscoverySource): Promise<void> {
    const state = this.sourceStatuses.get(source.source)!;
    const restored = await this.restoreSource(source.source);
    const attemptedAt = this.now();
    state.lastAttemptMs = attemptedAt.getTime();
    state.lastAttemptAt = attemptedAt.toISOString();
    const revision = state.discoveryRevision + 1;
    const previousProviders = this.activeProviders(source.source);
    let catalogCommitted = false;
    try {
      const generation = this.generations.get(source.source);
      if (!generation || generation.source !== source) throw new Error(`Tool discovery source ${source.source} is no longer active`);
      const providers = await this.discover(source, generation);
      this.registry.synchronize(source.source, providers);
      catalogCommitted = true;
      const succeededAt = this.now().toISOString();
      const catalog = providers.map(snapshotToolSpec);
      const fingerprint = executionToolCatalogFingerprint(catalog);
      await this.saveDiscovery({
        schemaVersion: 1, source: source.source, revision, outcome: "ready",
        lastAttemptAt: attemptedAt.toISOString(), lastSuccessAt: succeededAt, lastFailure: null,
        lastSuccessfulCatalog: catalog, catalogFingerprint: fingerprint, updatedAt: succeededAt,
      });
      state.status = "ready";
      state.lastSuccessAt = succeededAt;
      state.lastError = null;
      state.discoveredProviders = providers.length;
      state.discoveryRevision = revision;
      state.lastSuccessfulCatalogFingerprint = fingerprint;
      state.restoredFromPersistence = false;
      state.diagnostics = source.diagnostics?.() ?? null;
    } catch (error) {
      if (catalogCommitted) this.registry.synchronize(source.source, previousProviders);
      const failedAt = this.now().toISOString();
      const failure = boundedMessage(error);
      state.status = "degraded";
      state.lastError = failure;
      state.discoveryRevision = revision;
      state.diagnostics = source.diagnostics?.() ?? null;
      const lastCatalog = state.restoredFromPersistence
        ? (restored?.lastSuccessfulCatalog.map(snapshotToolSpec) ?? [])
        : previousProviders.map(snapshotToolSpec);
      try {
        await this.saveDiscovery({
          schemaVersion: 1, source: source.source, revision, outcome: "degraded",
          lastAttemptAt: attemptedAt.toISOString(), lastSuccessAt: state.lastSuccessAt,
          lastFailure: { message: failure, at: failedAt }, lastSuccessfulCatalog: lastCatalog,
          catalogFingerprint: executionToolCatalogFingerprint(lastCatalog), updatedAt: failedAt,
        });
      } catch (persistenceError) {
        state.lastError = boundedMessage(new Error(`${failure}; discovery state persistence failed: ${boundedMessage(persistenceError)}`));
      }
    }
  }

  private activeProviders(source: string): ExecutionToolAdapter[] {
    return this.registry.list().filter((state) => state.provider.source === source && state.lifecycle === "active").map((state) => state.provider);
  }

  private async saveDiscovery(snapshot: ExecutionToolDiscoverySnapshot): Promise<void> {
    await this.statePort?.save(snapshot);
  }

  private restoreSource(source: string): Promise<ExecutionToolDiscoverySnapshot | undefined> {
    if (!this.statePort) return Promise.resolve(undefined);
    const existing = this.sourceRestorations.get(source);
    if (existing) return existing;
    const restoration = this.statePort.load(source).then((snapshot) => {
      const state = this.sourceStatuses.get(source);
      if (!snapshot || !state || state.status !== "pending" || state.discoveryRevision > 0) return snapshot;
      state.lastAttemptAt = snapshot.lastAttemptAt;
      state.lastAttemptMs = Date.parse(snapshot.lastAttemptAt);
      state.lastSuccessAt = snapshot.lastSuccessAt;
      state.lastError = snapshot.lastFailure?.message ?? null;
      state.discoveredProviders = snapshot.lastSuccessfulCatalog.length;
      state.discoveryRevision = snapshot.revision;
      state.lastSuccessfulCatalogFingerprint = snapshot.catalogFingerprint;
      state.restoredFromPersistence = true;
      return snapshot;
    });
    this.sourceRestorations.set(source, restoration);
    return restoration;
  }

  private async discover(source: ExecutionToolDiscoverySource, generation: SourceGeneration): Promise<ExecutionToolAdapter[]> {
    const providers = await source.discover();
    return providers.map((provider) => {
      if (provider.source !== source.source) throw new Error(`Discovered tool ${provider.name} does not belong to source ${source.source}`);
      if (provider.timeoutMs < 1) throw new Error(`Execution tool ${provider.name} requires a positive timeout`);
      return {
        ...provider,
        execute: async (input, context) => {
          if (!generation.accepting) throw drainingError(provider.name, provider.version);
          generation.inFlight += 1;
          try { return await provider.execute(input, context); }
          finally {
            generation.inFlight -= 1;
            if (!generation.accepting && generation.inFlight === 0) generation.resolveDrained();
          }
        },
      };
    });
  }

  private beginDrain(generation: SourceGeneration): Promise<void> {
    generation.accepting = false;
    if (generation.inFlight === 0) generation.resolveDrained();
    return generation.drained;
  }

  private resume(generation: SourceGeneration): void {
    if (generation.accepting) return;
    let resolveDrained!: () => void;
    generation.drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
    generation.resolveDrained = resolveDrained;
    generation.accepting = true;
  }

  private closeGeneration(generation: SourceGeneration): Promise<void> {
    if (generation.closePromise) return generation.closePromise;
    generation.closePromise = this.beginDrain(generation).then(() => generation.source.close?.() ?? Promise.resolve());
    return generation.closePromise;
  }

  private trackRetirement(retirement: Promise<void>): Promise<void> {
    this.retirements.add(retirement);
    void retirement.finally(() => { this.retirements.delete(retirement); }).catch(() => undefined);
    return retirement;
  }
}

function boundedMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "Unknown tool discovery failure";
  return value.slice(0, 1_024);
}

function createGeneration(source: ExecutionToolDiscoverySource): SourceGeneration {
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
  return { source, accepting: true, inFlight: 0, drained, resolveDrained, closePromise: null };
}

function drainingError(name: string, version: string): Error & { retryable: true } {
  return Object.assign(new Error(`Tool ${name}@${version} began draining before invocation ownership was acquired`), { retryable: true as const });
}

export function staticExecutionToolSource(source: string, tools: readonly ExecutionToolAdapter[]): ExecutionToolDiscoverySource {
  return { source, async discover() { return [...tools]; } };
}
