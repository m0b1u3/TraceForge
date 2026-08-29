import { checkScope } from "@traceforge/tool-resolver";
import type { ScopeRule } from "@traceforge/shared";
import type { ExecutionToolAdapter } from "@traceforge/worker-runtime";
import type { ScenarioOutputSchema, ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import { WEB_BLACKBOX_AUTHORIZATION_SCOPE, WEB_BLACKBOX_SCENARIO } from "./definition.js";
import {
  ScenarioBrowserObserveTool,
  ScenarioHttpRequestTool,
  ScenarioSessionOpenTool,
  ScenarioScopeSnapshotTool,
  ScenarioTrafficSnapshotTool,
} from "./tools.js";

const outputKinds = [
  "scope_snapshot",
  "capability_inventory",
  "surface_observation",
  "coverage_assessment",
  "hypothesis",
  "validation_conclusion",
  "limitation",
  "evidence_review",
  "report",
] as const;

const outputSchemas: ScenarioOutputSchema[] = outputKinds.map((kind) => ({
  kind,
  version: 1,
  validate(output) {
    if (!output.id.trim() || !output.summary.trim()) throw new Error(`Web black-box ${kind} output requires id and summary`);
    if (output.refs.length === 0 || output.refs.some((ref) => !ref.trim())) {
      throw new Error(`Web black-box ${kind} output requires at least one attributable reference`);
    }
  },
  mapToEvidence({ run, output }) {
    const nodeKind = output.kind === "hypothesis"
      ? "hypothesis"
      : output.kind === "validation_conclusion"
        ? "validation_conclusion"
        : output.kind === "limitation"
          ? "limitation"
          : "fact";
    const status = nodeKind === "hypothesis" || nodeKind === "validation_conclusion" ? "candidate" : "active";
    return {
      id: `scenario-output:${run.id}:${output.id}`,
      kind: nodeKind,
      title: `${output.kind}: ${output.summary.slice(0, 120)}`,
      summary: output.summary,
      status,
      confidence: nodeKind === "fact" ? 1 : 0.5,
      properties: {
        scenarioOutputId: output.id,
        scenarioOutputKind: output.kind,
        scenarioOutputSchemaVersion: output.schemaVersion,
        refs: output.refs,
        phaseId: output.phaseId,
        producedByWorkId: output.producedByWorkId,
      },
    };
  },
}));

export const WEB_BLACKBOX_PACKAGE: ScenarioPackageInstallation = {
  id: "traceforge.web-blackbox",
  version: "0.1.0",
  schemaRevision: 1,
  definition: WEB_BLACKBOX_SCENARIO,
  outputSchemas,
  authorizationPolicy: {
    parseScope(input) {
      const scope = WEB_BLACKBOX_AUTHORIZATION_SCOPE.parse(input);
      return { payload: scope, allowedActions: scope.allowedActions, deniedActions: scope.deniedActions };
    },
    authorizeResource(scopePayload, resourceKind, value) {
      if (resourceKind !== "network.url") throw new Error(`Web black-box does not authorize ${resourceKind} resources`);
      const scope = WEB_BLACKBOX_AUTHORIZATION_SCOPE.parse(scopePayload);
      let url: URL;
      try { url = new URL(value); }
      catch { throw new Error("Web tool URL must be an absolute HTTP or HTTPS URL"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Web tool URL must use HTTP or HTTPS and must not contain embedded credentials");
      }
      const rules: ScopeRule[] = [{
        caseId: "scenario-authorization",
        allowHosts: scope.targets.map((target) => {
          try { return new URL(target).host; }
          catch { return target.trim().toLowerCase(); }
        }).filter(Boolean),
        denyHosts: [],
      }];
      const verdict = checkScope(url.href, rules);
      if (!verdict.allowed) throw new Error(`Target is outside authorization: ${verdict.reason}`);
      return url.href;
    },
  },
  createToolSources(context) {
    const tools: ExecutionToolAdapter[] = [
      new ScenarioScopeSnapshotTool(context.authorization),
      new ScenarioTrafficSnapshotTool(context.authorization, context.traffic),
      new ScenarioSessionOpenTool(context.authorization, context.sessions),
      ...(context.executionNode ? [new ScenarioHttpRequestTool(context.authorization, context.sessions, context.traffic, context.executionNode)] : []),
      new ScenarioBrowserObserveTool(context.authorization, context.sessions, context.traffic),
    ];
    return [{
      source: `scenario:${WEB_BLACKBOX_SCENARIO.kind}@${WEB_BLACKBOX_SCENARIO.version}`,
      async discover() { return tools; },
    }];
  },
};
