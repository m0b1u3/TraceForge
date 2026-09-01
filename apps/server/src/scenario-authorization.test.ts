import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { ScenarioDefinition } from "@traceforge/orchestration-core";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { ScenarioPackageRegistry, type ScenarioPackageInstallation } from "@traceforge/scenario-sdk";

const definition: ScenarioDefinition = {
  kind: "fixture.neutral",
  version: 1,
  title: "Neutral authorization fixture",
  authorizationActions: ["fixture.read"],
  requiredCapabilities: ["fixture.read"],
  workKinds: [{ id: "first_work", defaultWorkerRoles: ["first_role"] }],
  initialPhaseId: "first_phase",
  agentTopology: {
    planner: { enabled: false, pollIntervalMs: 1_000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1, maximumProposalsPerEvaluation: 1 },
    observer: { enabled: false, pollIntervalMs: 1_000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1 },
    workerPools: [{
      id: "first_pool", role: "first_role", workKinds: ["first_work"], activation: "on_demand",
      minimumInstances: 0, maximumInstances: 1, maxConcurrentWork: 1, capabilities: ["fixture.read"],
    }],
  },
  phases: [{
    id: "first_phase", title: "First phase", objective: "Review a subject", allowedWorkKinds: ["first_work"],
    maxParallelWork: 1, requiredCapabilities: ["fixture.read"], transitions: [{ to: "complete", allOf: [{ kind: "first_output" }] }],
  }],
};

const scenarioPackage: ScenarioPackageInstallation = {
  id: "fixture.neutral",
  version: "1.0.0",
  schemaRevision: 1,
  definition,
  outputSchemas: [{
    kind: "first_output",
    version: 1,
    validate(output) { if (!output.summary.trim()) throw new Error("summary required"); },
  }],
  authorizationPolicy: {
    parseScope(input) {
      const scope = input as { subjects: string[]; allowed: string[]; denied?: string[] };
      if (!Array.isArray(scope.subjects) || !Array.isArray(scope.allowed)) throw new Error("Invalid neutral scope");
      return { payload: scope, allowedActions: scope.allowed, deniedActions: scope.denied ?? [] };
    },
    authorizeResource(scopePayload, resourceKind, value) {
      const scope = scopePayload as { subjects: string[] };
      if (resourceKind !== "fixture.subject" || !scope.subjects.includes(value)) throw new Error("Subject is outside authorization");
      return `subject:${value}`;
    },
  },
  createToolSources() { return []; },
};

const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("SqliteScenarioAuthorizationService", () => {
  it("delegates opaque Scope parsing and resource authorization to the installed Scenario Package", () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    sqlite.prepare("INSERT INTO cases (id, name, status, scope_rules_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("case_1", "Neutral case", "active", "{}", "2026-08-28T00:00:00.000Z");
    sqlite.prepare(`
      INSERT INTO scenario_authorizations
        (id, case_id, scenario_kind, scope_json, approved_by, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      "scope_1", "case_1", definition.kind,
      JSON.stringify({ subjects: ["first"], allowed: ["fixture.read"], denied: [] }),
      "operator_1", "2027-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z", "2026-08-28T00:00:00.000Z",
    );
    const service = new SqliteScenarioAuthorizationService(
      sqlite,
      new ScenarioPackageRegistry([scenarioPackage]),
      () => Date.parse("2026-08-28T01:00:00.000Z"),
    );

    service.pin("scope_1","case_1",{id:scenarioPackage.id,version:scenarioPackage.version,schemaRevision:scenarioPackage.schemaRevision},0);
    expect(service.requireAction("scope_1", "case_1", "fixture.read")).toMatchObject({ scenarioKind: "fixture.neutral" });
    expect(service.authorizeResource("scope_1", "case_1", "fixture.read", "fixture.subject", "first").canonicalValue)
      .toBe("subject:first");
    expect(() => service.authorizeResource("scope_1", "case_1", "fixture.read", "fixture.subject", "second"))
      .toThrow("outside authorization");
    expect(() => service.requireAction("scope_1", "another_case", "fixture.read")).toThrow("assigned Case");
  });
});
