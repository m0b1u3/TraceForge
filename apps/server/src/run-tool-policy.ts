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
    private readonly workspace: RunWorkspace | undefined, private readonly platform: PermissionProfile["platform"],
    private readonly liveInquiryMode?: () => boolean,
    private readonly browserToolAvailable?: (tool: ExecutionToolSpec) => boolean) {}

  private rule(tool: ExecutionToolSpec) {
    const rules = this.definition.toolPolicies?.filter(rule => rule.source === tool.source && tool.providedCapabilities.includes(rule.capability)) ?? [];
    if (rules.length > 1) throw new Error("Ambiguous Scenario tool policy");
    return rules[0];
  }
  private approvedAction(assignment: Attribution, action: string) {
    if (!this.definition.authorizationActions.includes(action) || !this.authorization) throw new Error("Tool action is not declared or authorized");
    return this.authorization.requireAction(assignment.runContext.scopeRef, assignment.runContext.caseId, action);
  }
  private inquiryMode(assignment: Attribution): boolean | undefined {
    if (this.liveInquiryMode) return this.liveInquiryMode();
    const payload = this.authorization?.requireScope(assignment.runContext.scopeRef, assignment.runContext.caseId).scope.payload;
    if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "routineApprovalRequired")) return undefined;
    const value = (payload as Record<string, unknown>).routineApprovalRequired;
    if (typeof value !== "boolean") throw new Error("Invalid routine approval preference");
    return value;
  }
  requiresApproval(assignment: Attribution, tool: ExecutionToolSpec): boolean {
    return this.inquiryMode(assignment) === true && tool.risk === "bounded_write";
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
      let network = false;
      if (rule && action === "workspace.execute") {
        try { this.approvedAction(assignment, "workspace.network"); network = true; } catch { /* Old scopes stay offline. */ }
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
  approval(assignment: Attribution, tool: ExecutionToolSpec) {
    const rule = this.rule(tool);
    // Host-owned workspace adapters enforce path ownership and native isolation.
    // An arbitrary provider or raw process executor cannot opt into this path.
    if(this.inquiryMode(assignment)===false && rule?.profile==="run-workspace" && this.workspace && tool.source==="traceforge.builtin"
      && ["workspace_execute","workspace_start","workspace_input","workspace_stop","workspace_stage","workspace_remove"].includes(tool.name)) {
      try {
        this.approvedAction(assignment,rule.authorizationAction);
        this.approvedAction(assignment,workspaceAction(tool.name)!);
        const profile=this.layers(assignment,tool)[0]?.profile;
        if(profile?.process.access==="sandboxed"&&profile.secrets==="deny"&&profile.process.background===false
          && ["deny","brokered"].includes(profile.network))return {decision:"approved" as const,reason:`Desktop isolation mode: ${tool.name} confined to the owned workspace; no host privilege granted`};
      }catch{ /* Revoked or unavailable isolation never gains an execution fallback. */ }
    }
    // This is a concrete, visible Scope grant for ongoing input to an already
    // owned process, not the desktop's blanket routine-approval preference.
    // Asking again would release the Work lease and terminate that process.
    if (tool.name === "workspace_input" && tool.source === "traceforge.builtin"
      && rule?.profile === "run-workspace" && rule.capability === "workspace.input"
      && rule.authorizationAction === "workspace.execute") {
      try {
        const grant = this.approvedAction(assignment, "workspace.execute");
        if ((grant.scopePayload as Record<string, unknown>)?.interactiveWorkspace === true)
          return { decision: "approved" as const, reason: `User Scope ${assignment.runContext.scopeRef} explicitly grants continuous input to its owned workspace terminal` };
      } catch { /* No grant or revoked Scope: ordinary rejection still applies. */ }
    }
    // An explicit desktop mode supersedes legacy blanket autonomy. High-risk
    // tools still need a real invocation grant in both modes.
    if (this.inquiryMode(assignment) !== undefined) return undefined;
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
