import type { BrokeredNetworkReceipt, ExecutionNode } from "@traceforge/execution-node";
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

export interface ExecutionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface ExecutionSessionDescriptor {
  id: string;
  caseId: string;
  runId: string;
  scopeRef: string;
  identityId: string | null;
  identityVersion: number | null;
  status: "active" | "frozen" | "closed" | "expired";
  lastWorkerId: string | null;
  lastWorkId: string | null;
  lastLeaseId: string | null;
  lastLeaseExpiresAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionUseContext {
  workerId: string;
  workId: string;
  caseId: string;
  runId: string;
  scopeRef: string;
  leaseId: string;
  leaseExpiresAt: string;
}

export interface SessionMaterial {
  session: ExecutionSessionDescriptor;
  headers: Record<string, string>;
  cookies: ExecutionCookie[];
}

export interface ScenarioSessionPort {
  openSession(input: { caseId: string; runId: string; scopeRef: string; identityId?: string; ttlMs?: number }): ExecutionSessionDescriptor;
  use(sessionId: string, context: SessionUseContext): SessionMaterial;
  updateCookies(sessionId: string, cookies: ExecutionCookie[]): void;
}

export interface ScenarioTrafficEntrySummary {
  id: string;
  runId: string;
  url: string;
  method: string;
  responseStatus: number | null;
  responseSize: number | null;
  contentType: string | null;
  createdAt: string;
}

export interface ScenarioTrafficPort {
  recordHttpExchange(input: {
    trafficId: string;
    caseId: string;
    runId: string;
    url: string;
    method: string;
    requestHeaders: Record<string, string>;
    requestBody: string | null;
    responseStatus: number;
    responseHeaders: Record<string, string>;
    responseSize: number;
    contentType: string | null;
    responseBody: string | null;
    receipt: BrokeredNetworkReceipt;
    createdAt: string;
  }): void;
  recordBrowserObservation(input: {
    trafficId: string;
    caseId: string;
    runId: string;
    url: string;
    responseStatus: number | null;
    responseSize: number;
    responseBody: string;
    createdAt: string;
  }): void;
  list(caseId: string, limit: number): ScenarioTrafficEntrySummary[];
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

export interface ScenarioToolHostContext {
  sessions: ScenarioSessionPort;
  authorization: ScenarioAuthorizationPort;
  traffic: ScenarioTrafficPort;
  evidence: ScenarioEvidencePort;
  executionNode?: ExecutionNode;
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

  constructor(packages: readonly ScenarioPackageInstallation[] = []) {
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

  requireForScenario(kind: string, version?: number): ScenarioPackageInstallation {
    const matches = [...this.packages.values()]
      .filter((scenarioPackage) => scenarioPackage.definition.kind === kind)
      .filter((scenarioPackage) => version === undefined || scenarioPackage.definition.version === version)
      .sort((left, right) => right.definition.version - left.definition.version);
    const scenarioPackage = matches[0];
    if (!scenarioPackage) throw new Error(`Scenario Package for ${kind}${version === undefined ? "" : `@${version}`} is not installed`);
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
    const sources = [...this.packages.values()].flatMap((scenarioPackage) => [...scenarioPackage.createToolSources(context)]);
    const sourceIds = new Set<string>();
    for (const source of sources) {
      if (!source.source.trim() || sourceIds.has(source.source)) throw new Error(`Duplicate or empty Scenario tool source ${source.source}`);
      sourceIds.add(source.source);
    }
    return sources;
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
