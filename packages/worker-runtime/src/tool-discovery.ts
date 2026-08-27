import { CapabilityProviderRegistry, type CapabilityProviderState } from "@traceforge/tool-resolver";
import type { ExecutionToolSpec } from "./model.js";
import type { ExecutionToolAdapter } from "./tool-gateway.js";

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

interface MutableSourceStatus extends ExecutionToolSourceStatus {
  lastAttemptMs: number | null;
}

export class ExecutionToolDiscoveryRuntime {
  readonly registry: CapabilityProviderRegistry<ExecutionToolAdapter>;
  private readonly sources = new Map<string, ExecutionToolDiscoverySource>();
  private readonly sourceStatuses = new Map<string, MutableSourceStatus>();
  private readonly refreshes = new Map<string, Promise<void>>();

  constructor(
    sources: readonly ExecutionToolDiscoverySource[],
    private readonly refreshIntervalMs = 30_000,
    unavailableAfterFailures = 3,
    private readonly now: () => Date = () => new Date(),
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
    this.sourceStatuses.set(id, {
      source: id, status: "pending", lastAttemptAt: null, lastSuccessAt: null, lastError: null,
      discoveredProviders: 0, diagnostics: null, lastAttemptMs: null,
    });
  }

  async refreshDue(): Promise<void> {
    const current = this.now().getTime();
    const due = [...this.sourceStatuses.values()]
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
    await Promise.all([...this.sources.values()].map((source) => source.close?.() ?? Promise.resolve()));
  }

  snapshot(): ExecutionToolRuntimeSnapshot {
    const sources = [...this.sourceStatuses.values()]
      .map(({ lastAttemptMs: _lastAttemptMs, ...state }) => ({
        ...state,
        diagnostics: this.sources.get(state.source)?.diagnostics?.() ?? state.diagnostics,
      }))
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

  private refreshOne(source: string): Promise<void> {
    const existing = this.refreshes.get(source);
    if (existing) return existing;
    const discovered = this.sources.get(source);
    if (!discovered) return Promise.reject(new Error(`Unknown tool discovery source: ${source}`));
    const refresh = this.performRefresh(discovered).finally(() => { this.refreshes.delete(source); });
    this.refreshes.set(source, refresh);
    return refresh;
  }

  private async performRefresh(source: ExecutionToolDiscoverySource): Promise<void> {
    const state = this.sourceStatuses.get(source.source)!;
    const attemptedAt = this.now();
    state.lastAttemptMs = attemptedAt.getTime();
    state.lastAttemptAt = attemptedAt.toISOString();
    try {
      const providers = await source.discover();
      for (const provider of providers) {
        if (provider.source !== source.source) throw new Error(`Discovered tool ${provider.name} does not belong to source ${source.source}`);
        if (provider.timeoutMs < 1) throw new Error(`Execution tool ${provider.name} requires a positive timeout`);
      }
      this.registry.synchronize(source.source, providers);
      state.status = "ready";
      state.lastSuccessAt = this.now().toISOString();
      state.lastError = null;
      state.discoveredProviders = providers.length;
      state.diagnostics = source.diagnostics?.() ?? null;
    } catch (error) {
      state.status = "degraded";
      state.lastError = error instanceof Error ? error.message : "Unknown tool discovery failure";
      state.diagnostics = source.diagnostics?.() ?? null;
    }
  }
}

export function staticExecutionToolSource(source: string, tools: readonly ExecutionToolAdapter[]): ExecutionToolDiscoverySource {
  return { source, async discover() { return [...tools]; } };
}
