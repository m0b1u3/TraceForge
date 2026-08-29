import { describe, expect, it } from "vitest";
import type { ScenarioDefinition } from "@traceforge/orchestration-core";
import { ScenarioPackageRegistry, type ScenarioPackageInstallation } from "./index.js";

const definition: ScenarioDefinition = {
  kind: "fixture.first-scenario",
  version: 1,
  title: "First neutral scenario",
  authorizationActions: ["fixture.subject.read"],
  requiredCapabilities: ["fixture.context.read"],
  workKinds: [{
    id: "fixture.first-work",
    defaultWorkerRoles: ["fixture.first-worker"],
    completion: { anyOfOutputKinds: ["fixture.first-output"] },
  }],
  initialPhaseId: "fixture.first-phase",
  agentTopology: {
    planner: { enabled: true, pollIntervalMs: 1_000, maximumGraphNodes: 10, maximumRecentEvents: 10, maximumRunItems: 10, maximumProposalsPerEvaluation: 1 },
    observer: { enabled: true, pollIntervalMs: 1_000, maximumGraphNodes: 10, maximumRecentEvents: 10, maximumRunItems: 10 },
    workerPools: [{
      id: "fixture.first-pool",
      role: "fixture.first-worker",
      workKinds: ["fixture.first-work"],
      activation: "on_demand",
      minimumInstances: 0,
      maximumInstances: 1,
      maxConcurrentWork: 1,
      capabilities: ["fixture.context.read"],
    }],
  },
  phases: [{
    id: "fixture.first-phase",
    title: "First phase",
    objective: "Process the first candidate without assuming a domain.",
    allowedWorkKinds: ["fixture.first-work"],
    maxParallelWork: 1,
    requiredCapabilities: ["fixture.context.read"],
    transitions: [{ to: "complete", allOf: [{ kind: "fixture.first-output" }] }],
  }],
};

function installation(overrides: Partial<ScenarioPackageInstallation> = {}): ScenarioPackageInstallation {
  return {
    id: "fixture.first-package",
    version: "1.0.0",
    schemaRevision: 2,
    definition,
    outputSchemas: [{ kind: "fixture.first-output", version: 1, validate() {} }],
    resourceManifest: {
      revision: 1,
      resources: [
        { id: "fixture.planner-prompt", kind: "prompt", version: 1, locator: "package://prompts/planner.txt", digest: `sha256:${"1".repeat(64)}` },
        { id: "fixture.first-knowledge", kind: "knowledge", version: 1, locator: "package://knowledge/first.json", digest: `sha256:${"2".repeat(64)}` },
        { id: "fixture.schema-migration", kind: "migration", version: 1, locator: "package://migrations/1-2.json", digest: `sha256:${"3".repeat(64)}` },
      ],
    },
    migrationManifest: {
      revision: 1,
      steps: [{ id: "fixture.schema-1-to-2", fromSchemaRevision: 1, toSchemaRevision: 2, resourceId: "fixture.schema-migration" }],
    },
    authorizationPolicy: { parseScope: (payload) => ({ payload, allowedActions: ["fixture.subject.read"], deniedActions: [] }) },
    createToolSources: () => [],
    ...overrides,
  };
}

describe("Scenario Package foundation contract", () => {
  it("registers open identifiers with versioned prompt, knowledge, and migration resources", () => {
    const registry = new ScenarioPackageRegistry([installation()]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.definitions()).toEqual([definition]);
  });

  it("rejects closed-enum-like unsafe identifiers without assigning domain meaning", () => {
    expect(() => new ScenarioPackageRegistry([installation({ id: "First Package" })]))
      .toThrow("must be an open lowercase identifier");
  });

  it("rejects migration steps that do not resolve through the package resource manifest", () => {
    expect(() => new ScenarioPackageRegistry([installation({
      migrationManifest: {
        revision: 1,
        steps: [{ id: "fixture.schema-1-to-2", fromSchemaRevision: 1, toSchemaRevision: 2, resourceId: "fixture.missing" }],
      },
    })])).toThrow("references missing resource fixture.missing");
  });

  it("keeps migration execution resources distinct from prompt and knowledge resources", () => {
    expect(() => new ScenarioPackageRegistry([installation({
      migrationManifest: {
        revision: 1,
        steps: [{ id: "fixture.schema-1-to-2", fromSchemaRevision: 1, toSchemaRevision: 2, resourceId: "fixture.planner-prompt" }],
      },
    })])).toThrow("must reference a migration resource");
  });
});
