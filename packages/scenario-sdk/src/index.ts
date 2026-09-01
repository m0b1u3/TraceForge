import type { KnowledgeNodeKind, KnowledgeNodeStatus } from "@traceforge/evidence-graph";
import type {
  ScenarioDefinition,
  ScenarioKind,
  ScenarioOutput,
  ScenarioOutputDraft,
  ScenarioPackageBinding,
  ScenarioRunBindingValidator,
  ScenarioRunState,
} from "@traceforge/orchestration-core";
import type { ExecutionToolDiscoverySource } from "@traceforge/worker-runtime";

export interface ActiveScenarioAuthorization {
  id: string;
  caseId: string;
  scenarioKind: ScenarioKind;
  scopePayload: unknown;
  expiresAt: string;
}

export interface ScenarioResourceAuthorization extends ActiveScenarioAuthorization {
  canonicalValue: string;
}

export interface ScenarioAuthorizationPort {
  requireAction(scopeRef: string, caseId: string, action: string): ActiveScenarioAuthorization;
  authorizeResource(
    scopeRef: string,
    caseId: string,
    action: string,
    resourceKind: string,
    value: string,
  ): ScenarioResourceAuthorization;
}

export interface ScenarioEvidenceNodeRecord {
  id: string;
  kind: KnowledgeNodeKind;
  title: string;
  summary: string;
  status: KnowledgeNodeStatus;
  confidence: number;
  properties: Record<string, unknown>;
}

export interface ScenarioEvidencePort {
  recordNode(input: {
    commandId: string;
    caseId: string;
    runId: string;
    node: ScenarioEvidenceNodeRecord;
    at: string;
  }): string[];
}

export interface ScenarioArtifactRecord {
  id: string;
  packageId: string;
  packageVersion: string;
  caseId: string;
  runId: string;
  kind: string;
  summary: string;
  contentRef: string;
  digest: `sha256:${string}`;
  byteSize: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ScenarioArtifactPort {
  record(input: Omit<ScenarioArtifactRecord, "id" | "createdAt"> & { commandId: string }): ScenarioArtifactRecord;
  get(input: { packageId: string; packageVersion: string; caseId: string; artifactId: string }): ScenarioArtifactRecord | undefined;
  list(input: { packageId: string; packageVersion: string; caseId: string; runId?: string; limit: number }): ScenarioArtifactRecord[];
}

export interface ScenarioStateRecord {
  packageId: string;
  packageVersion: string;
  caseId: string;
  runId: string;
  key: string;
  revision: number;
  value: unknown;
  updatedAt: string;
}

export interface ScenarioStatePort {
  read(input: { packageId: string; packageVersion: string; caseId: string; runId: string; key: string }): ScenarioStateRecord | undefined;
  compareAndSet(input: { commandId: string; packageId: string; packageVersion: string; caseId: string; runId: string;
    key: string; expectedRevision: number; value: unknown }): ScenarioStateRecord;
}

export interface ScenarioOutputSchema {
  kind: string;
  version: number;
  validate(output: ScenarioOutput): void;
  mapToEvidence?(input: { run: ScenarioRunState; output: ScenarioOutput }): ScenarioEvidenceNodeRecord | null;
}

export interface ScenarioPackageResource {
  id: string;
  kind: string;
  version: number;
  locator: string;
  digest: `sha256:${string}`;
  /** Explicit opt-in to model discovery; migration/assets are never implicitly exposed. */
  context?: ScenarioContextResource;
}

export { validateSkillContract, validateSkillRecord } from "./skill-contract.js";
import { validateSkillContract, type ScenarioSkillContract } from "./skill-contract.js";
export type { ScenarioSkillContract, SkillRecordContract } from "./skill-contract.js";

export interface ScenarioContextResource {
  type: "skill" | "knowledge";
  summary: string;
  authorizationAction: string;
  requiredCapabilities: string[];
  phaseIds: string[];
  /** References are package-local; each still requires an independent authorized read. */
  references: string[];
  validFrom?: string;
  expiresAt?: string;
  /** Explicit unresolved contradictions; these are not inferred from sample content. */
  conflictsWith?: string[];
  /** Other roles must be explicitly allowed to consume derived context from this resource. */
  readerRoles?: Array<"worker" | "planner" | "observer">;
  skill?: ScenarioSkillContract;
  /** Host-reviewed source and exact content identity; never an arbitrary model-supplied URL. */
  external?: { source: string; profileDigest: `sha256:${string}`; kind: "resource" | "prompt"; target: string; arguments?: Record<string, string> };
}

export interface ScenarioPackageResourceManifest {
  revision: number;
  resources: readonly ScenarioPackageResource[];
}

export interface ScenarioPackageMigrationStep {
  id: string;
  fromSchemaRevision: number;
  toSchemaRevision: number;
  resourceId: string;
}

export interface ScenarioPackageMigrationManifest {
  revision: number;
  steps: readonly ScenarioPackageMigrationStep[];
}

export interface ScenarioHostCapabilities {
  optional<T>(id: string): T | undefined;
  require<T>(id: string): T;
}

export function createScenarioHostCapabilities(entries: Readonly<Record<string, unknown>>): ScenarioHostCapabilities {
  const values = new Map(Object.entries(entries));
  return Object.freeze({
    optional<T>(id: string): T | undefined { return values.get(id) as T | undefined; },
    require<T>(id: string): T {
      if (!values.has(id)) throw new Error(`Scenario host capability ${id} is unavailable`);
      return values.get(id) as T;
    },
  });
}

export interface ScenarioToolHostContext {
  authorization: ScenarioAuthorizationPort;
  evidence: ScenarioEvidencePort;
  artifacts: ScenarioArtifactPort;
  state: ScenarioStatePort;
  capabilities: ScenarioHostCapabilities;
  execution?: import("@traceforge/worker-runtime").GovernedExecutionPort;
}

export interface ScenarioPackageInstallation {
  id: string;
  version: string;
  schemaRevision: number;
  definition: ScenarioDefinition;
  outputSchemas: readonly ScenarioOutputSchema[];
  resourceManifest?: ScenarioPackageResourceManifest;
  migrationManifest?: ScenarioPackageMigrationManifest;
  authorizationPolicy: {
    parseScope(input: unknown): { payload: unknown; allowedActions: string[]; deniedActions: string[] };
    authorizeResource?(scopePayload: unknown, resourceKind: string, value: string): string;
  };
  createToolSources(context: ScenarioToolHostContext): readonly ExecutionToolDiscoverySource[];
}

export class ScenarioPackageBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioPackageBindingError";
  }
}

export type ScenarioPackageBindingStatus =
  | { status: "available"; package: ScenarioPackageInstallation }
  | { status: "recovery_required"; reason: string };

export class ScenarioPackageRegistry implements ScenarioRunBindingValidator {
  private readonly packages = new Map<string, ScenarioPackageInstallation>();

  constructor(packages: readonly ScenarioPackageInstallation[] = [],private readonly usagePolicy?:(installation:ScenarioPackageInstallation)=>void) {
    const definitions = new Set<string>();
    for (const scenarioPackage of packages) {
      const id = scenarioPackage.id.trim();
      if (!id) throw new Error("Scenario Package id is required");
      const version = scenarioPackage.version.trim();
      if (!version) throw new Error(`Scenario Package ${id} version is required`);
      if (!Number.isInteger(scenarioPackage.schemaRevision) || scenarioPackage.schemaRevision < 1) {
        throw new Error(`Scenario Package ${id}@${version} schema revision must be a positive integer`);
      }
      const packageKey = this.packageKey(id, version);
      if (this.packages.has(packageKey)) throw new Error(`Duplicate Scenario Package ${packageKey}`);
      const definitionId = `${scenarioPackage.definition.kind}@${scenarioPackage.definition.version}`;
      if (definitions.has(definitionId)) throw new Error(`Duplicate Scenario Definition ${definitionId}`);
      definitions.add(definitionId);
      this.validateOpenIdentifiers(scenarioPackage);
      this.validateOutputSchemas(scenarioPackage);
      this.validateResourceManifests(scenarioPackage);
      this.packages.set(packageKey, scenarioPackage);
    }
  }

  definitions(): ScenarioDefinition[] {
    return [...this.packages.values()].map((scenarioPackage) => scenarioPackage.definition);
  }

  /** Host policy is synchronous and evaluated at use time; metadata enumeration does not grant use. */
  assertAvailable(installation:ScenarioPackageInstallation):void {
    try {
      const result:unknown=this.usagePolicy?.(installation);
      if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new Error("Package usage policy must be synchronous");}
    }catch(error){throw new ScenarioPackageBindingError(error instanceof Error?error.message:"Scenario Package is not currently trusted");}
  }

  requireForScenario(kind: string, version?: number): ScenarioPackageInstallation {
    const matches = [...this.packages.values()]
      .filter((scenarioPackage) => scenarioPackage.definition.kind === kind)
      .filter((scenarioPackage) => version === undefined || scenarioPackage.definition.version === version)
      .sort((left, right) => right.definition.version - left.definition.version);
    const scenarioPackage = matches[0];
    if (!scenarioPackage) throw new Error(`Scenario Package for ${kind}${version === undefined ? "" : `@${version}`} is not installed`);
    this.assertAvailable(scenarioPackage);
    return scenarioPackage;
  }

  bindingFor(scenarioPackage: ScenarioPackageInstallation): ScenarioPackageBinding {
    return {
      id: scenarioPackage.id,
      version: scenarioPackage.version,
      schemaRevision: scenarioPackage.schemaRevision,
    };
  }

  prepareOutputs(
    state: ScenarioRunState,
    drafts: readonly ScenarioOutputDraft[],
    phaseId: string,
    producedByWorkId: string,
  ): ScenarioOutput[] {
    const scenarioPackage = this.requireBinding(state.scenarioPackage, state.definitionKind, state.definitionVersion);
    return drafts.map((draft) => {
      const schema = scenarioPackage.outputSchemas.find((candidate) => candidate.kind === draft.kind);
      if (!schema) throw new Error(`Scenario Package ${scenarioPackage.id}@${scenarioPackage.version} has no Output Schema for ${draft.kind}`);
      const output: ScenarioOutput = { ...draft, schemaVersion: schema.version, phaseId, producedByWorkId };
      schema.validate(output);
      return output;
    });
  }

  mapOutputsToEvidence(state: ScenarioRunState, outputs: readonly ScenarioOutput[], evidence: ScenarioEvidencePort): string[] {
    const scenarioPackage = this.requireBinding(state.scenarioPackage, state.definitionKind, state.definitionVersion);
    return outputs.flatMap((output) => {
      const schema = scenarioPackage.outputSchemas.find((candidate) =>
        candidate.kind === output.kind && candidate.version === output.schemaVersion);
      if (!schema) throw new Error(`Output ${output.id} requires unavailable Schema ${output.kind}@${output.schemaVersion}`);
      schema.validate(output);
      const node = schema.mapToEvidence?.({ run: state, output });
      if (!node) return [];
      return evidence.recordNode({
        commandId: `scenario-output:${state.id}:${output.id}:${output.schemaVersion}`,
        caseId: state.caseId,
        runId: state.id,
        node,
        at: output.createdAt,
      });
    });
  }

  requireBinding(
    binding: ScenarioPackageBinding | null,
    definitionKind: string,
    definitionVersion: number,
  ): ScenarioPackageInstallation {
    if (!binding) throw new ScenarioPackageBindingError(
      `Scenario Run ${definitionKind}@${definitionVersion} has no Package binding and requires explicit recovery`,
    );
    const scenarioPackage = this.packages.get(this.packageKey(binding.id, binding.version));
    if (!scenarioPackage) {
      throw new ScenarioPackageBindingError(`Scenario Package ${binding.id}@${binding.version} required by Run is not installed`);
    }
    if (scenarioPackage.schemaRevision !== binding.schemaRevision) {
      throw new ScenarioPackageBindingError(
        `Scenario Package ${binding.id}@${binding.version} schema revision mismatch: Run requires ${binding.schemaRevision}, installed ${scenarioPackage.schemaRevision}`,
      );
    }
    if (scenarioPackage.definition.kind !== definitionKind || scenarioPackage.definition.version !== definitionVersion) {
      throw new ScenarioPackageBindingError(
        `Scenario Package ${binding.id}@${binding.version} does not provide required Definition ${definitionKind}@${definitionVersion}`,
      );
    }
    this.assertAvailable(scenarioPackage);
    return scenarioPackage;
  }

  bindingStatus(
    binding: ScenarioPackageBinding | null,
    definitionKind: string,
    definitionVersion: number,
  ): ScenarioPackageBindingStatus {
    try {
      return { status: "available", package: this.requireBinding(binding, definitionKind, definitionVersion) };
    } catch (error) {
      if (!(error instanceof ScenarioPackageBindingError)) throw error;
      return { status: "recovery_required", reason: error.message };
    }
  }

  requireAvailable(state: ScenarioRunState): void {
    this.requireBinding(state.scenarioPackage, state.definitionKind, state.definitionVersion);
  }

  toolSources(context: ScenarioToolHostContext): ExecutionToolDiscoverySource[] {
    const sources = [...this.packages.values()].flatMap((scenarioPackage) => {
      this.assertAvailable(scenarioPackage);
      return [...scenarioPackage.createToolSources(this.scopeHostContext(context, scenarioPackage))];
    });
    const sourceIds = new Set<string>();
    for (const source of sources) {
      if (!source.source.trim() || sourceIds.has(source.source)) throw new Error(`Duplicate or empty Scenario tool source ${source.source}`);
      sourceIds.add(source.source);
    }
    return sources;
  }

  private scopeHostContext(
    context: ScenarioToolHostContext,
    scenarioPackage: Pick<ScenarioPackageInstallation, "id" | "version">,
  ): ScenarioToolHostContext {
    const requireOwner = (input: { packageId: string; packageVersion: string }) => {
      if (input.packageId !== scenarioPackage.id || input.packageVersion !== scenarioPackage.version) {
        throw new Error(`Scenario Package ${scenarioPackage.id}@${scenarioPackage.version} cannot access another package owner`);
      }
    };
    return Object.freeze({
      ...context,
      artifacts: Object.freeze({
        record: (input: Parameters<ScenarioArtifactPort["record"]>[0]) => { requireOwner(input); return context.artifacts.record(input); },
        get: (input: Parameters<ScenarioArtifactPort["get"]>[0]) => { requireOwner(input); return context.artifacts.get(input); },
        list: (input: Parameters<ScenarioArtifactPort["list"]>[0]) => { requireOwner(input); return context.artifacts.list(input); },
      }),
      state: Object.freeze({
        read: (input: Parameters<ScenarioStatePort["read"]>[0]) => { requireOwner(input); return context.state.read(input); },
        compareAndSet: (input: Parameters<ScenarioStatePort["compareAndSet"]>[0]) => {
          requireOwner(input);
          return context.state.compareAndSet(input);
        },
      }),
    });
  }

  list(): ScenarioPackageInstallation[] {
    return [...this.packages.values()].sort((left, right) =>
      left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
  }

  private packageKey(id: string, version: string): string {
    return `${id}@${version}`;
  }

  private validateOutputSchemas(scenarioPackage: ScenarioPackageInstallation): void {
    const schemas = new Map<string, ScenarioOutputSchema>();
    for (const schema of scenarioPackage.outputSchemas) {
      if (!schema.kind.trim() || !Number.isInteger(schema.version) || schema.version < 1) {
        throw new Error(`Scenario Package ${scenarioPackage.id}@${scenarioPackage.version} has an invalid Output Schema`);
      }
      if (schemas.has(schema.kind)) throw new Error(`Duplicate Output Schema ${schema.kind}`);
      schemas.set(schema.kind, schema);
    }
    const referenced = new Set<string>();
    for (const workKind of scenarioPackage.definition.workKinds) {
      for (const kind of workKind.completion?.anyOfOutputKinds ?? []) referenced.add(kind);
    }
    for (const phase of scenarioPackage.definition.phases) {
      for (const transition of phase.transitions) {
        for (const requirement of [...(transition.allOf ?? []), ...(transition.anyOf ?? []), ...(transition.noneOf ?? [])]) {
          referenced.add(requirement.kind);
        }
      }
    }
    const missing = [...referenced].filter((kind) => !schemas.has(kind));
    if (missing.length) {
      throw new Error(`Scenario Package ${scenarioPackage.id}@${scenarioPackage.version} lacks Output Schemas: ${missing.join(", ")}`);
    }
  }

  private validateOpenIdentifiers(scenarioPackage: ScenarioPackageInstallation): void {
    const requireIdentifier = (value: string, label: string) => {
      if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(value)) {
        throw new Error(`${label} must be an open lowercase identifier, received ${JSON.stringify(value)}`);
      }
    };
    requireIdentifier(scenarioPackage.id, "Scenario Package id");
    requireIdentifier(scenarioPackage.definition.kind, "Scenario Definition kind");
    const identities: Array<[string, string]> = [];
    for (const action of scenarioPackage.definition.authorizationActions) identities.push([action, "authorization action"]);
    for (const capability of scenarioPackage.definition.requiredCapabilities) identities.push([capability, "required capability"]);
    for (const workKind of scenarioPackage.definition.workKinds) {
      identities.push([workKind.id, "Work kind"]);
      for (const role of workKind.defaultWorkerRoles) identities.push([role, "Worker role"]);
      for (const outputKind of workKind.completion?.anyOfOutputKinds ?? []) identities.push([outputKind, "Output kind"]);
    }
    for (const pool of scenarioPackage.definition.agentTopology.workerPools) {
      identities.push([pool.id, "Worker pool id"], [pool.role, "Worker pool role"]);
      for (const workKind of pool.workKinds) identities.push([workKind, "Worker pool Work kind"]);
      for (const capability of pool.capabilities) identities.push([capability, "Worker capability"]);
    }
    for (const phase of scenarioPackage.definition.phases) {
      identities.push([phase.id, "Phase id"]);
      for (const workKind of phase.allowedWorkKinds) identities.push([workKind, "Phase Work kind"]);
      for (const capability of phase.requiredCapabilities) identities.push([capability, "Phase capability"]);
      for (const transition of phase.transitions) {
        if (transition.to !== "complete") identities.push([transition.to, "Transition phase id"]);
        for (const requirement of [...(transition.allOf ?? []), ...(transition.anyOf ?? []), ...(transition.noneOf ?? [])]) {
          identities.push([requirement.kind, "Transition Output kind"]);
        }
      }
    }
    for (const schema of scenarioPackage.outputSchemas) identities.push([schema.kind, "Output Schema kind"]);
    for (const [value, label] of identities) requireIdentifier(value, label);
  }

  private validateResourceManifests(scenarioPackage: ScenarioPackageInstallation): void {
    const resourceManifest = scenarioPackage.resourceManifest;
    const migrationManifest = scenarioPackage.migrationManifest;
    if (!resourceManifest && !migrationManifest) return;
    if (!resourceManifest) throw new Error(`Scenario Package ${scenarioPackage.id} migrations require a Resource Manifest`);
    if (!Number.isInteger(resourceManifest.revision) || resourceManifest.revision < 1) {
      throw new Error(`Scenario Package ${scenarioPackage.id} Resource Manifest revision must be a positive integer`);
    }
    const resources = new Map<string, ScenarioPackageResource>();
    if (resourceManifest.resources.length > 1024) throw new Error("Scenario Package resource count exceeds limit");
    for (const resource of resourceManifest.resources) {
      if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(resource.id)
        || !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(resource.kind)
        || !Number.isInteger(resource.version) || resource.version < 1
        || !resource.locator.trim()
        || !/^sha256:[0-9a-f]{64}$/.test(resource.digest)) {
        throw new Error(`Scenario Package ${scenarioPackage.id} has an invalid resource ${JSON.stringify(resource.id)}`);
      }
      if (resources.has(resource.id)) throw new Error(`Duplicate Scenario Package resource ${resource.id}`);
      resources.set(resource.id, resource);
      const context = resource.context;
      if (context?.readerRoles && (!Array.isArray(context.readerRoles) || !context.readerRoles.length || context.readerRoles.length > 3
        || context.readerRoles.some((role) => !["worker", "planner", "observer"].includes(role))
        || new Set(context.readerRoles).size !== context.readerRoles.length)) throw new Error("Invalid context reader roles");
      if (context?.skill) {
        if (context.type !== "skill") throw new Error("Only Skill resources may declare Skill contracts");
        validateSkillContract(context.skill);
      }
      if (context?.external) {
        const remote = context.external;
        if (!remote.source.trim() || remote.source.length > 128 || !/^sha256:[a-f0-9]{64}$/.test(remote.profileDigest)
          || !["resource", "prompt"].includes(remote.kind) || !remote.target.trim() || remote.target.length > 1024
          || (remote.arguments !== undefined && (remote.kind !== "prompt" || !remote.arguments || typeof remote.arguments !== "object" || Array.isArray(remote.arguments)
            || Object.keys(remote.arguments).length > 16 || Object.entries(remote.arguments).some(([k, v]) =>
              !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) || typeof v !== "string" || v.length > 256)))) throw new Error("Invalid external context binding");
      }
      if (context && ((!["skill", "knowledge"].includes(context.type))
        || resource.id.length > 128 || resource.locator.length > 1024
        || !context.summary.trim() || context.summary.length > 512
        || !context.authorizationAction.trim() || context.authorizationAction.length > 128
        || ![context.requiredCapabilities, context.phaseIds, context.references, context.conflictsWith ?? []].every((values) =>
          Array.isArray(values) && values.length <= 32 && values.every((value) => typeof value === "string" && value.trim() && value.length <= 128))
        || [context.validFrom, context.expiresAt].some((value) => value !== undefined &&
          (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value))))
        || (context.validFrom !== undefined && context.expiresAt !== undefined && Date.parse(context.validFrom) >= Date.parse(context.expiresAt))
        || context.phaseIds.some((id) => !scenarioPackage.definition.phases.some((phase) => phase.id === id)))) {
        throw new Error(`Scenario Package resource ${resource.id} has invalid context metadata`);
      }
    }
    for (const resource of resources.values()) {
      if (resource.context?.references.some((id) => !resources.get(id)?.context)) {
        throw new Error(`Scenario Package resource ${resource.id} references a missing context resource`);
      }
      if (resource.context?.conflictsWith?.some((id) => id === resource.id || !resources.get(id)?.context)) {
        throw new Error(`Scenario Package resource ${resource.id} has an invalid conflict reference`);
      }
    }
    if (!migrationManifest) return;
    if (!Number.isInteger(migrationManifest.revision) || migrationManifest.revision < 1) {
      throw new Error(`Scenario Package ${scenarioPackage.id} Migration Manifest revision must be a positive integer`);
    }
    const steps = new Set<string>();
    for (const step of migrationManifest.steps) {
      if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(step.id)
        || !Number.isInteger(step.fromSchemaRevision) || step.fromSchemaRevision < 1
        || !Number.isInteger(step.toSchemaRevision) || step.toSchemaRevision <= step.fromSchemaRevision
        || step.toSchemaRevision > scenarioPackage.schemaRevision) {
        throw new Error(`Scenario Package ${scenarioPackage.id} has an invalid migration step ${JSON.stringify(step.id)}`);
      }
      if (steps.has(step.id)) throw new Error(`Duplicate Scenario Package migration ${step.id}`);
      steps.add(step.id);
      const resource = resources.get(step.resourceId);
      if (!resource) {
        throw new Error(`Scenario Package migration ${step.id} references missing resource ${step.resourceId}`);
      }
      if (resource.kind !== "migration") {
        throw new Error(`Scenario Package migration ${step.id} must reference a migration resource`);
      }
    }
  }
}
export * from "./run-migration.js";
