import type Database from "better-sqlite3";
import type { ScenarioKind } from "@traceforge/orchestration-core";
import type {
  ActiveScenarioAuthorization,
  ScenarioAuthorizationPort,
  ScenarioResourceAuthorization,
} from "@traceforge/scenario-sdk";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";

interface AuthorizationRow {
  id: string;
  case_id: string;
  scenario_kind: ScenarioKind;
  scope_json: string;
  status: string;
  expires_at: string;
}

export class SqliteScenarioAuthorizationService implements ScenarioAuthorizationPort {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly packages: ScenarioPackageRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  requireAction(scopeRef: string, caseId: string, action: string): ActiveScenarioAuthorization {
    const { row, scope } = this.requireEnvelope(scopeRef, caseId);
    if (scope.deniedActions.includes(action)) throw new Error(`Action ${action} is explicitly denied by ${scopeRef}`);
    if (!scope.allowedActions.includes(action)) throw new Error(`Action ${action} is not authorized by ${scopeRef}`);
    return { id: row.id, caseId: row.case_id, scenarioKind: row.scenario_kind, scopePayload: scope.payload, expiresAt: row.expires_at };
  }

  authorizeResource(
    scopeRef: string,
    caseId: string,
    action: string,
    resourceKind: string,
    value: string,
  ): ScenarioResourceAuthorization {
    const authorization = this.requireAction(scopeRef, caseId, action);
    const scenarioPackage = this.packages.requireForScenario(authorization.scenarioKind);
    const authorize = scenarioPackage.authorizationPolicy.authorizeResource;
    if (!authorize) throw new Error(`Scenario ${authorization.scenarioKind} does not authorize ${resourceKind} resources`);
    return { ...authorization, canonicalValue: authorize(authorization.scopePayload, resourceKind, value) };
  }

  private requireEnvelope(scopeRef: string, caseId: string) {
    const row = this.sqlite.prepare(`
      SELECT id, case_id, scenario_kind, scope_json, status, expires_at
      FROM scenario_authorizations WHERE id = ?
    `).get(scopeRef) as AuthorizationRow | undefined;
    if (!row || row.case_id !== caseId) throw new Error(`Scope authorization ${scopeRef} does not belong to the assigned Case`);
    if (row.status !== "active" || Date.parse(row.expires_at) <= this.now()) {
      throw new Error(`Scope authorization ${scopeRef} is expired or revoked`);
    }
    const scenarioPackage = this.packages.requireForScenario(row.scenario_kind);
    return { row, scope: scenarioPackage.authorizationPolicy.parseScope(JSON.parse(row.scope_json)) };
  }
}
