import type { ScenarioDefinition, PermissionProfile } from "@traceforge/orchestration-core";
import type { ExecutionToolSpec, RunWorkspace } from "@traceforge/worker-runtime";
import { workspaceAction } from "@traceforge/worker-runtime";
import type { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";

type Attribution = { runId: string; runContext: { caseId: string; scopeRef: string } };
/** Installed tool contracts select supported Host profiles. Work ownership and
 * native execution isolation remain in Tool Gateway and Execution Node. */
export class RunToolPolicy {
  constructor(private readonly definition: ScenarioDefinition, private readonly authorization: SqliteScenarioAuthorizationService | undefined,
    private readonly workspace: RunWorkspace | undefined, private readonly platform: PermissionProfile["platform"],
    private readonly browserToolAvailable?: (tool: ExecutionToolSpec) => boolean) {}

  private rule(tool: ExecutionToolSpec) {
    const rules = this.definition.toolPolicies?.filter(rule => rule.source === tool.source && tool.providedCapabilities.includes(rule.capability)) ?? [];
    if (rules.length > 1) throw new Error("Ambiguous Scenario tool policy");
    return rules[0];
  }
  private approvedAction(assignment: Attribution, action: string) {
    if (!this.authorization) throw new Error("Run authorization is unavailable");
    return this.authorization.requireAction(assignment.runContext.scopeRef, assignment.runContext.caseId, action);
  }
  requiresApproval(_assignment: Attribution, _tool: ExecutionToolSpec): boolean {
    return false;
  }
  layers(assignment: Attribution, tool: ExecutionToolSpec): Array<{ source: string; profile: PermissionProfile }> {
    const rule = this.rule(tool), action = workspaceAction(tool.name);
    if (rule?.profile === "browser-host") {
      if (!this.browserToolAvailable?.(tool)) return this.denied();
      try { this.approvedAction(assignment, rule.authorizationAction); } catch { return this.denied(); }
      return [{ source: `scenario:${this.definition.kind}@${this.definition.version}:browser-host`, profile: {
        version: 1, platform: this.platform, filesystem: { read: [], write: [], deny: [] }, network: "brokered",
        process: { access: "sandboxed", interactive: false, background: false }, secrets: "handles_only",
      } }];
    }
    // Old packages keep their prior workspace behavior, never gain autonomy.
    const workspaceProfile = rule?.profile === "run-workspace" || (!this.definition.toolPolicies && action && tool.source === "traceforge.builtin");
    if (workspaceProfile) {
      if (!action || tool.source !== "traceforge.builtin" || !this.workspace) return this.denied();
      let enabled = true;
      try { this.approvedAction(assignment, action); if (rule) this.approvedAction(assignment, rule.authorizationAction); } catch { enabled = false; }
      let network: boolean | "direct" = false;
      if (rule && action === "workspace.execute") {
        try {
          const grant = this.approvedAction(assignment, "workspace.network");
          network = (grant.scopePayload as Record<string, unknown>)?.directWorkspaceNetwork === true ? "direct" : true;
        } catch { /* Old scopes stay offline. */ }
      }
      let interactive = false;
      if (rule && action === "workspace.execute") {
        try { interactive = (this.approvedAction(assignment, action).scopePayload as Record<string, unknown>)?.interactiveWorkspace === true; } catch { /* Old scopes stay non-interactive. */ }
      }
      return [{ source: `run-workspace:${assignment.runId}`, profile: this.workspace.profile(assignment.runContext.caseId, assignment.runId, tool.name, enabled, network, interactive) }];
    }
    if (rule) this.approvedAction(assignment, rule.authorizationAction);
    // Host broker tools receive handles and broker access, not arbitrary process
    // authority. New process modes need an implemented Host profile first.
    return [{ source: `scenario:${this.definition.kind}@${this.definition.version}:brokered-host`, profile: {
      version: 1, platform: this.platform, filesystem: { read: [], write: [], deny: [] }, network: "brokered",
      process: { access: "deny", interactive: false, background: false }, secrets: "handles_only",
    } }];
  }
  approval(assignment: Attribution, _tool: ExecutionToolSpec) {
    if (!this.authorization) return undefined;
    this.authorization.requireScope(assignment.runContext.scopeRef, assignment.runContext.caseId);
    return { decision: "approved" as const, reason: "Installed tool available to this active Run" };
  }
  private denied(): Array<{ source: string; profile: PermissionProfile }> {
    return [{ source: "unavailable-tool-policy", profile: { version: 1, platform: this.platform, filesystem: { read: [], write: [], deny: [] }, network: "deny", process: { access: "deny", interactive: false, background: false }, secrets: "deny" } }];
  }
}
