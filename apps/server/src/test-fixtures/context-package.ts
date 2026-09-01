import { ScenarioPackageRegistry, type ScenarioPackageInstallation, type ScenarioSkillContract } from "@traceforge/scenario-sdk";
import { contextContentDigest } from "../package-context-resources.js";
import { definition } from "./execution-recovery.js";

export const contextText = "Preserve each candidate independently. These instructions do not grant permission or verify findings.";
export const contextBinding = { id: "neutral", version: "1.0.0", schemaRevision: 1 };
export const skillContract: ScenarioSkillContract = { version: 1,
  input: { fields: { candidate: { type: "string", required: true } } },
  output: { fields: { recorded: { type: "boolean", required: true }, notes: { type: "string_list", required: false } } },
  checks: [{ id: "recorded", field: "recorded", equals: true }] };
export function enableSkillContract(pkg: ScenarioPackageInstallation) {
  pkg.resourceManifest!.resources[0]!.context!.skill = structuredClone(skillContract);
  pkg.definition.authorizationActions.push("context.skill.prepare", "context.skill.evaluate");
  const parse = pkg.authorizationPolicy.parseScope;
  pkg.authorizationPolicy.parseScope = (payload) => ({ ...parse(payload), allowedActions: [...parse(payload).allowedActions, "context.skill.prepare", "context.skill.evaluate"] });
}
export function contextPackage(capabilities = ["context.catalog", "context.read"]): ScenarioPackageInstallation {
  return { ...contextBinding, definition: { ...definition, requiredCapabilities: capabilities, authorizationActions: ["context.catalog", "context.read", "fixture.read"],
    phases: definition.phases.map((p) => ({ ...p, requiredCapabilities: capabilities })),
    agentTopology: { ...definition.agentTopology, workerPools: definition.agentTopology.workerPools.map((p) => ({ ...p, capabilities })) } },
    outputSchemas: [{ kind: "decision", version: 1, validate() {} }],
    resourceManifest: { revision: 1, resources: [{ id: "first", kind: "text", version: 1, locator: "package:first", digest: contextContentDigest(contextText),
      context: { type: "skill", summary: "Neutral candidate handling", authorizationAction: "context.read",
        requiredCapabilities: ["context.read"], phaseIds: ["observe"], references: [] } }] },
    authorizationPolicy: { parseScope: (payload) => ({ payload, allowedActions: ["context.catalog", "context.read", "fixture.read"], deniedActions: [] }),
      authorizeResource: (_scope, _kind, value) => value }, createToolSources: () => [] };
}
export function contextFoundation() {
  return { scenarioPackageRegistry: new ScenarioPackageRegistry([contextPackage()]), toolDiscoverySources: [],
    contextResourceContents: [{ package: contextBinding, resourceId: "first", content: contextText }] };
}
