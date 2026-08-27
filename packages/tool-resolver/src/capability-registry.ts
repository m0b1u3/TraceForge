export type ToolProviderLifecycle = "active" | "draining" | "retired";
export type ToolProviderHealth = "healthy" | "degraded" | "unavailable";

export interface CapabilityProviderDescriptor {
  name: string;
  source: string;
  version: string;
  priority: number;
  providedCapabilities: string[];
  dependencyCapabilities: string[];
}

export interface CapabilityProviderState<T extends CapabilityProviderDescriptor> {
  provider: T;
  lifecycle: ToolProviderLifecycle;
  health: ToolProviderHealth;
  consecutiveFailures: number;
  lastFailure: string | null;
  revision: number;
}

export interface CapabilityResolution<T extends CapabilityProviderDescriptor> {
  providers: T[];
  requestedCapabilities: string[];
  unresolvedCapabilities: string[];
  registryRevision: number;
}

export class CapabilityProviderRegistry<T extends CapabilityProviderDescriptor> {
  private readonly states = new Map<string, CapabilityProviderState<T>>();
  private revision = 0;

  constructor(private readonly unavailableAfterFailures = 3) {
    if (!Number.isInteger(unavailableAfterFailures) || unavailableAfterFailures < 1) {
      throw new Error("Provider failure threshold must be a positive integer");
    }
  }

  register(provider: T): void {
    validateProvider(provider);
    if (this.states.has(provider.name)) throw new Error(`Capability provider already registered: ${provider.name}`);
    const registered = cloneProvider(provider);
    this.revision += 1;
    this.states.set(provider.name, {
      provider: registered, lifecycle: "active", health: "healthy", consecutiveFailures: 0,
      lastFailure: null, revision: this.revision,
    });
  }

  synchronize(source: string, providers: readonly T[]): { registered: string[]; replaced: string[]; draining: string[]; revision: number } {
    if (!source.trim()) throw new Error("Capability provider source is required");
    const discovered = new Map<string, T>();
    for (const provider of providers) {
      validateProvider(provider);
      if (provider.source !== source) throw new Error(`Provider discovery result does not belong to source ${source}`);
      if (discovered.has(provider.name)) throw new Error(`Provider source ${source} returned duplicate name ${provider.name}`);
      const current = this.states.get(provider.name);
      if (current && current.provider.source !== source) throw new Error(`Capability provider name ${provider.name} is already owned by source ${current.provider.source}`);
      if (current?.lifecycle === "retired" && current.provider.version === provider.version) {
        throw new Error(`Retired provider ${provider.name} requires a new version`);
      }
      discovered.set(provider.name, provider);
    }
    const registered: string[] = [];
    const replaced: string[] = [];
    const draining: string[] = [];
    for (const state of [...this.states.values()]) {
      if (state.provider.source !== source) continue;
      const next = discovered.get(state.provider.name);
      if (state.lifecycle === "retired") {
        if (next) {
          discovered.delete(state.provider.name);
          this.replace(next);
          replaced.push(next.name);
        }
        continue;
      }
      if (!next) {
        this.setLifecycle(state.provider.name, "draining");
        draining.push(state.provider.name);
        continue;
      }
      discovered.delete(state.provider.name);
      if (next.version !== state.provider.version) {
        this.setLifecycle(state.provider.name, "retired");
        this.replace(next);
        replaced.push(next.name);
      } else if (state.lifecycle === "draining") {
        this.setLifecycle(state.provider.name, "active");
      }
    }
    for (const provider of discovered.values()) {
      this.register(provider);
      registered.push(provider.name);
    }
    return { registered: registered.sort(), replaced: replaced.sort(), draining: draining.sort(), revision: this.revision };
  }

  replace(provider: T): void {
    validateProvider(provider);
    const current = this.states.get(provider.name);
    if (current && current.lifecycle !== "retired") throw new Error(`Capability provider ${provider.name} must be retired before replacement`);
    if (current?.provider.version === provider.version) throw new Error(`Replacement provider ${provider.name} must use a new version`);
    const registered = cloneProvider(provider);
    this.revision += 1;
    this.states.set(provider.name, {
      provider: registered, lifecycle: "active", health: "healthy", consecutiveFailures: 0,
      lastFailure: null, revision: this.revision,
    });
  }

  setLifecycle(name: string, lifecycle: ToolProviderLifecycle): void {
    const state = this.require(name);
    if (state.lifecycle === "retired" && lifecycle !== "retired") throw new Error(`Retired provider ${name} cannot be reactivated; register a new version`);
    if (state.lifecycle === lifecycle) return;
    this.revision += 1;
    state.lifecycle = lifecycle;
    state.revision = this.revision;
  }

  setHealth(name: string, health: ToolProviderHealth, reason?: string): void {
    const state = this.require(name);
    this.revision += 1;
    state.health = health;
    state.lastFailure = health === "healthy" ? null : reason?.trim() || state.lastFailure;
    if (health === "healthy") state.consecutiveFailures = 0;
    state.revision = this.revision;
  }

  recordSuccess(name: string): void {
    const state = this.require(name);
    if (state.health === "healthy" && state.consecutiveFailures === 0 && state.lastFailure === null) return;
    this.revision += 1;
    state.health = "healthy";
    state.consecutiveFailures = 0;
    state.lastFailure = null;
    state.revision = this.revision;
  }

  recordFailure(name: string, reason: string): void {
    const state = this.require(name);
    this.revision += 1;
    state.consecutiveFailures += 1;
    state.lastFailure = reason.trim() || "Provider failure";
    state.health = state.consecutiveFailures >= this.unavailableAfterFailures ? "unavailable" : "degraded";
    state.revision = this.revision;
  }

  get(name: string): CapabilityProviderState<T> | undefined {
    const state = this.states.get(name);
    return state ? cloneState(state) : undefined;
  }

  list(): CapabilityProviderState<T>[] {
    return [...this.states.values()].map(cloneState).sort((left, right) => left.provider.name.localeCompare(right.provider.name));
  }

  resolve(
    requiredCapabilities: readonly string[],
    eligible: (state: CapabilityProviderState<T>) => boolean = () => true,
  ): CapabilityResolution<T> {
    const known = new Set([...this.states.values()]
      .filter((state) => state.lifecycle !== "retired")
      .flatMap((state) => state.provider.providedCapabilities));
    const requestedCapabilities = [...new Set(requiredCapabilities)].filter((capability) => known.has(capability)).sort();
    const uncovered = new Set(requestedCapabilities);
    const candidates = [...this.states.values()].filter((state) =>
      state.lifecycle === "active" && state.health !== "unavailable" && eligible(cloneState(state)),
    );
    const selected: T[] = [];

    while (uncovered.size) {
      const ranked = candidates
        .filter((state) => !selected.some((provider) => provider.name === state.provider.name))
        .map((state) => ({
          state,
          coverage: state.provider.providedCapabilities.filter((capability) => uncovered.has(capability)).length,
        }))
        .filter((candidate) => candidate.coverage > 0)
        .sort((left, right) =>
          right.coverage - left.coverage
          || healthRank(left.state.health) - healthRank(right.state.health)
          || right.state.provider.priority - left.state.provider.priority
          || left.state.provider.name.localeCompare(right.state.provider.name)
          || left.state.provider.version.localeCompare(right.state.provider.version));
      const next = ranked[0]?.state.provider;
      if (!next) break;
      selected.push(next);
      for (const capability of next.providedCapabilities) uncovered.delete(capability);
      for (const dependency of next.dependencyCapabilities) {
        if (known.has(dependency) && !selected.some((provider) => provider.providedCapabilities.includes(dependency))) uncovered.add(dependency);
      }
    }

    return {
      providers: selected,
      requestedCapabilities,
      unresolvedCapabilities: [...uncovered].sort(),
      registryRevision: this.revision,
    };
  }

  private require(name: string): CapabilityProviderState<T> {
    const state = this.states.get(name);
    if (!state) throw new Error(`Unknown capability provider: ${name}`);
    return state;
  }
}

function validateProvider(provider: CapabilityProviderDescriptor): void {
  if (!provider.name.trim()) throw new Error("Capability provider name is required");
  if (!provider.source.trim()) throw new Error(`Capability provider ${provider.name} requires a source`);
  if (!provider.version.trim()) throw new Error(`Capability provider ${provider.name} requires a version`);
  if (!Number.isFinite(provider.priority)) throw new Error(`Capability provider ${provider.name} requires a finite priority`);
  const capabilities = provider.providedCapabilities.map((capability) => capability.trim());
  if (!capabilities.length || capabilities.some((capability) => !capability)) {
    throw new Error(`Capability provider ${provider.name} must provide at least one named capability`);
  }
  if (new Set(capabilities).size !== capabilities.length) throw new Error(`Capability provider ${provider.name} contains duplicate capabilities`);
  const dependencies = provider.dependencyCapabilities.map((capability) => capability.trim());
  if (dependencies.some((capability) => !capability)) throw new Error(`Capability provider ${provider.name} contains an empty dependency capability`);
  if (new Set(dependencies).size !== dependencies.length) throw new Error(`Capability provider ${provider.name} contains duplicate dependency capabilities`);
}

function healthRank(health: ToolProviderHealth): number {
  return health === "healthy" ? 0 : health === "degraded" ? 1 : 2;
}

function cloneState<T extends CapabilityProviderDescriptor>(state: CapabilityProviderState<T>): CapabilityProviderState<T> {
  return { ...state, provider: cloneProvider(state.provider) };
}

function cloneProvider<T extends CapabilityProviderDescriptor>(provider: T): T {
  return {
    ...provider,
    providedCapabilities: [...provider.providedCapabilities],
    dependencyCapabilities: [...provider.dependencyCapabilities],
  };
}
