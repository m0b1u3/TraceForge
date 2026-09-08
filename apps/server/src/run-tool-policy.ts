import type { ScenarioDefinition, PermissionProfile } from "@traceforge/orchestration-core";
import type { ExecutionToolSpec, RunWorkspace } from "@traceforge/worker-runtime";
import { workspaceAction } from "@traceforge/worker-runtime";
import type { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";

type Attribution = { runId: string; runContext: { caseId: string; scopeRef: string } };
/** Package ceilings select supported Host profiles, never raw host paths or an
 * unrestricted launcher. Scope controls consent; Work/Worker filtering remains
 * in Tool Gateway. No provider can opt itself into automatic approval. */
export class RunToolPolicy {
  constructor(private readonly definition: ScenarioDefinition, private readonly authorization: SqliteScenarioAuthorizationService | undefined,
    private readonly workspace: RunWorkspace | undefined, private readonly platform: PermissionProfile["platform"]) {}

  private rule(tool: ExecutionToolSpec) {
    const rules = this.definition.toolPolicies?.filter(rule => rule.source === tool.source && tool.providedCapabilities.includes(rule.capability)) ?? [];
    if (rules.length > 1) throw new Error("Ambiguous Scenario tool policy");
    return rules[0];
  }
  private approvedAction(assignment: Attribution, action: string) {
    if (!this.definition.authorizationActions.includes(action) || !this.authorization) throw new Error("Tool action is not declared or authorized");
    return this.authorization.requireAction(assignment.runContext.scopeRef, assignment.runContext.caseId, action);
  }
  layers(assignment: Attribution, tool: ExecutionToolSpec): Array<{ source: string; profile: PermissionProfile }> {
    const rule = this.rule(tool), action = workspaceAction(tool.name);
    // Old packages keep their prior workspace behavior, never gain autonomy.
    const workspaceProfile = rule?.profile === "run-workspace" || (!this.definition.toolPolicies && action && tool.source === "traceforge.builtin");
    if (workspaceProfile) {
      if (!action || tool.source !== "traceforge.builtin" || !this.workspace) return this.denied();
      let enabled = true;
      try { this.approvedAction(assignment, action); if (rule) this.approvedAction(assignment, rule.authorizationAction); } catch { enabled = false; }
      return [{ source: `run-workspace:${assignment.runId}`, profile: this.workspace.profile(assignment.runContext.caseId, assignment.runId, tool.name, enabled) }];
    }
    if (rule) this.approvedAction(assignment, rule.authorizationAction);
    // Host broker tools receive handles and broker access, not arbitrary process
    // authority. New process modes need an implemented Host profile first.
    return [{ source: `scenario:${this.definition.kind}@${this.definition.version}:brokered-host`, profile: {
      version: 1, platform: this.platform, filesystem: { read: [], write: [], deny: [] }, network: "brokered",
      process: { access: "deny", interactive: false, background: false }, secrets: "handles_only",
    } }];
  }
  approval(assignment: Attribution, tool: ExecutionToolSpec) {
    const rule = this.rule(tool);
    // Only implemented Run-owned mutations are eligible. Other privileged tools
    // still ask, even if a package attaches a similarly named consent field.
    if (!rule?.autonomousScopeFlag || rule.profile !== "run-workspace" || tool.source !== "traceforge.builtin" || !workspaceAction(tool.name)) return undefined;
    try {
      const grant = this.approvedAction(assignment, rule.authorizationAction);
      this.approvedAction(assignment, workspaceAction(tool.name)!);
      const payload = grant.scopePayload;
      if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, rule.autonomousScopeFlag) || (payload as Record<string, unknown>)[rule.autonomousScopeFlag] !== true) return undefined;
      return { decision: "approved" as const, reason: `User Scope ${assignment.runContext.scopeRef} explicitly grants autonomous ${rule.capability} within ${rule.profile}` };
    } catch { return undefined; }
  }
  private denied(): Array<{ source: string; profile: PermissionProfile }> {
    return [{ source: "unavailable-tool-policy", profile: { version: 1, platform: this.platform, filesystem: { read: [], write: [], deny: [] }, network: "deny", process: { access: "deny", interactive: false, background: false }, secrets: "deny" } }];
  }
}
