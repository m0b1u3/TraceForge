import { describe, expect, it } from "vitest";
import type { ScenarioDefinition } from "@traceforge/orchestration-core";
import { assertDeclarativeScenarioContract, authorizeScenarioResource, mapScenarioOutputToEvidence, parseScenarioScope,
  parseScenarioPackageDescriptor, SCENARIO_PROCESS_PROTOCOL, ScenarioPackageRegistry, validateScenarioOutput, validateSkillContract, validateSkillRecord,
  type ScenarioSkillContract, type ScenarioPackageInstallation } from "./index.js";

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

function descriptor(overrides:Record<string,unknown>={}){
  return {format:"traceforge.scenario-package.v1",package:{id:"fixture.first-package",version:"1.0.0",schemaRevision:2},
    definition:structuredClone(definition),authorizationPolicy:{format:"traceforge.scenario-scope-policy.v1",allowedActions:["fixture.subject.read"],deniedActions:[],
      payload:{maximumBytes:1024,maximumDepth:4},resources:[{kind:"fixture.subject",payloadPath:["subjects"]}]},
    outputContracts:[{kind:"fixture.first-output",version:1,format:"traceforge.scenario-output-contract.v1",maximumSummaryBytes:1024,maximumRefs:8}],
    runtime:{protocol:SCENARIO_PROCESS_PROTOCOL,protocolVersion:1,id:"fixture.first-package",version:"1.0.0",source:"scenario:fixture",
      entrypoint:"package://runtime/main.mjs",providedCapabilities:["fixture.context.read"],hostCapabilities:[]},...overrides};
}

describe("Scenario Package foundation contract", () => {
  const contract: ScenarioSkillContract = { version: 1, input: { fields: { candidate: { type: "string", required: true } } },
    output: { fields: { complete: { type: "boolean", required: true } } }, checks: [{ id: "complete", field: "complete", equals: true }] };
  it("validates bounded Skill data independently of Scenario outputs", () => {
    expect(() => validateSkillContract(contract)).not.toThrow();
    expect(() => validateSkillRecord(contract.input, { candidate: "first" })).not.toThrow();
    expect(() => validateSkillRecord(contract.output, { complete: true })).not.toThrow();
  });
  it("interprets bounded declarative scope, resource, output and evidence contracts without callbacks", () => {
    const policy = { format: "traceforge.scenario-scope-policy.v1" as const, allowedActions: ["fixture.subject.read"], deniedActions: [],
      payload: { maximumBytes: 1024, maximumDepth: 4 }, resources: [
        { kind: "fixture.subject", payloadPath: ["subjects"] }, { kind: "fixture.static", values: ["first"] },
        { kind:"fixture.namespace",payloadPrefixPath:["namespaces"] },
      ] };
    const output = { kind: "fixture.first-output", version: 1, format: "traceforge.scenario-output-contract.v1" as const,
      maximumSummaryBytes: 128, maximumRefs: 2, referencePrefixes: ["evidence:"], evidence: {
        kind: "evidence" as const, status: "active" as const, confidence: 0.8, title: { source: "output.summary" as const },
        summary: { literal: "Recorded by declarative mapping" }, properties: { run: { source: "run.id" as const }, refs: { source: "output.refs" as const } },
      } };
    const pkg = installation({ authorizationPolicy: policy, outputSchemas: [output] });
    expect(() => assertDeclarativeScenarioContract(pkg)).not.toThrow();
    const scope = parseScenarioScope(policy, { subjects: ["first", "second"] });
    expect(authorizeScenarioResource(policy, scope.payload, "fixture.subject", "second")).toBe("second");
    expect(authorizeScenarioResource(policy,{namespaces:["tenant:first/"]},"fixture.namespace","tenant:first/item")).toBe("tenant:first/item");
    expect(()=>authorizeScenarioResource(policy,{namespaces:["tenant:first/"]},"fixture.namespace","tenant:second/item")).toThrow(/does not authorize/);
    expect(() => authorizeScenarioResource(policy, scope.payload, "fixture.subject", "third")).toThrow(/does not authorize/);
    const value = { id: "output", kind: output.kind, schemaVersion: 1, summary: "Observed", refs: ["evidence:first"],
      phaseId: "phase", producedByWorkId: "work", createdAt: "2026-09-03T00:00:00.000Z" };
    expect(() => validateScenarioOutput(output, value)).not.toThrow();
    expect(mapScenarioOutputToEvidence(output, { id: "run", caseId: "case" } as never, value)).toMatchObject({
      id: "output", title: "Observed", summary: "Recorded by declarative mapping", properties: { run: "run", refs: ["evidence:first"] } });
    expect(() => parseScenarioScope({ ...policy, payload: { maximumBytes: 1024, maximumDepth: 1 } }, { nested: { too: { deep: true } } }))
      .toThrow(/depth/);
  });
  it("rejects malformed, unknown and over-capacity declarative contract data", () => {
    const policy = { format: "traceforge.scenario-scope-policy.v1" as const, allowedActions: ["fixture.subject.read"], deniedActions: [],
      payload: { maximumBytes: 1024, maximumDepth: 4 }, resources: [{ kind: "fixture.subject", values: ["first"] }] };
    const contract = { kind: "fixture.first-output", version: 1, format: "traceforge.scenario-output-contract.v1" as const,
      maximumSummaryBytes: 8, maximumRefs: 1, referencePrefixes: ["evidence:"] };
    expect(() => assertDeclarativeScenarioContract(installation({ authorizationPolicy: { ...policy, execute: "forbidden" } as never,
      outputSchemas: [contract] }))).toThrow(/Unknown declarative contract field/);
    expect(() => assertDeclarativeScenarioContract(installation({ authorizationPolicy: { ...policy, resources: [null] } as never,
      outputSchemas: [contract] }))).toThrow(/resource rule/);
    expect(() => assertDeclarativeScenarioContract(installation({ authorizationPolicy: { ...policy,
      resources: [{kind:"fixture.subject",values:["first"],prefixValues:["first/"]}] } as never, outputSchemas: [contract] })))
      .toThrow(/resource rule/);
    expect(() => assertDeclarativeScenarioContract(installation({ authorizationPolicy: { ...policy,
      resources: [{kind:"fixture.subject",prefixValues:[""]}] } as never, outputSchemas: [contract] })))
      .toThrow(/resource rule/);
    expect(() => assertDeclarativeScenarioContract(installation({ authorizationPolicy: policy, outputSchemas: [{ ...contract,
      evidence: { kind: "evidence", status: "active", confidence: Number.NaN, title: { source: "output.summary" },
        summary: { literal: "summary" } } as never }] }))).toThrow(/evidence mapping/);
    expect(() => validateScenarioOutput(contract, { kind: contract.kind, schemaVersion: 1, summary: "123456789", refs: [] } as never))
      .toThrow(/exceeds/);
    expect(() => validateScenarioOutput(contract, { kind: contract.kind, schemaVersion: 1, summary: "ok", refs: ["other:first"] } as never))
      .toThrow(/reference violates/);
  });
  it("constructs an immutable process-only Package from a data descriptor",()=>{
    const pkg=parseScenarioPackageDescriptor(descriptor());
    expect(pkg).toMatchObject({id:"fixture.first-package",version:"1.0.0",
      runtime:{entrypoint:"package://runtime/main.mjs"}});
    expect(Object.hasOwn(pkg,"createToolSources")).toBe(false);
    expect(Object.isFrozen(pkg)).toBe(true);expect(Object.isFrozen(pkg.definition)).toBe(true);
  });
  it.each([
    {execute:"forbidden"},
    {runtime:{...descriptor().runtime as object,entrypoint:"package://../escape.mjs"}},
    {resourceManifest:{revision:1,resources:[{id:"fixture.notes",kind:"knowledge",version:1,locator:"package://../notes.txt",
      digest:`sha256:${"1".repeat(64)}`,context:{type:"knowledge",summary:"Notes",authorizationAction:"fixture.subject.read",
        requiredCapabilities:[],phaseIds:[],references:[]}}]}},
    {package:{id:"fixture.first-package",version:"1.0.0",schemaRevision:2,callback:"forbidden"}},
  ])("rejects executable, unsafe or unknown descriptor fields %#",override=>{
    expect(()=>parseScenarioPackageDescriptor(descriptor(override))).toThrow();
  });
  it.each(["unknown", "version", "missing_field", "wrong_type", "duplicate", "optional"])("rejects malformed Skill %s contracts", (mode) => {
    const c = structuredClone(contract);
    if (mode === "unknown") Object.assign(c.input, { script: "do-not-execute" });
    if (mode === "version") c.version = 0;
    if (mode === "missing_field") c.checks[0]!.field = "missing";
    if (mode === "wrong_type") c.checks[0]!.equals = "true";
    if (mode === "duplicate") c.checks.push(c.checks[0]!);
    if (mode === "optional") c.output.fields.complete!.required = false;
    expect(() => validateSkillContract(c)).toThrow();
  });
  it.each([null, [], {}, { candidate: 1 }, { candidate: "first", extra: "unreviewed" }, { candidate: "x".repeat(1025) }])("rejects incompatible Skill data %#", (input) => {
    expect(() => validateSkillRecord(contract.input, input)).toThrow();
  });
  it("does not allow a knowledge resource to masquerade as a Skill contract", () => {
    const pkg = installation(); pkg.resourceManifest!.resources[0]!.context = { type: "knowledge", summary: "notes",
      authorizationAction: "fixture.subject.read", requiredCapabilities: [], phaseIds: [], references: [], skill: contract };
    expect(() => new ScenarioPackageRegistry([pkg])).toThrow("Only Skill");
  });
  it("registers open identifiers with versioned prompt, knowledge, and migration resources", () => {
    const registry = new ScenarioPackageRegistry([installation()]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.definitions()).toEqual([definition]);
  });

  it("never executes an in-process tool factory without an explicit development opt-in", () => {
    let factories = 0;
    const registry = new ScenarioPackageRegistry([installation({ createToolSources: () => { factories++; return []; } })]);
    expect(() => registry.toolSources({} as never)).toThrow(/outside explicit development mode/);
    expect(factories).toBe(0);
    expect(registry.toolSources({} as never, { allowInProcessDevelopment: true })).toEqual([]);
    expect(factories).toBe(1);
  });

  it("registers a process-only Package without loading an in-process tool factory", () => {
    const pkg = installation({ createToolSources: undefined, runtime: {
      protocol: SCENARIO_PROCESS_PROTOCOL, protocolVersion: 1, id: "fixture.first-package", version: "1.0.0",
      source: "scenario:fixture", entrypoint: "package://runtime/main.mjs",
      providedCapabilities: ["fixture.context.read"], hostCapabilities: [],
    } });
    const registry = new ScenarioPackageRegistry([pkg]);
    expect(registry.list()[0]!.runtime?.source).toBe("scenario:fixture");
    expect(() => registry.toolSources({} as never)).toThrow(/process-runtime assembly/);
  });

  it("rejects ambiguous or mismatched Package execution forms", () => {
    const runtime = { protocol: SCENARIO_PROCESS_PROTOCOL, protocolVersion: 1 as const, id: "fixture.first-package", version: "1.0.0",
      source: "scenario:fixture", entrypoint: "package://runtime/main.mjs",
      providedCapabilities: ["fixture.context.read"], hostCapabilities: [] };
    expect(() => new ScenarioPackageRegistry([installation({ runtime })])).toThrow(/exactly one execution form/);
    expect(() => new ScenarioPackageRegistry([installation({ createToolSources: undefined,
      runtime: { ...runtime, id: "fixture.second-package" } })])).toThrow(/identity mismatch/);
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
