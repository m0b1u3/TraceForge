import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb, getSqliteClient } from "./db/client.js";
import { ExecutionSessionGateway, SqliteEncryptedSecretVault } from "./execution-session-gateway.js";

const databases: Database.Database[] = [];

function setup() {
  const sqlite = getSqliteClient(createDb(":memory:"));
  databases.push(sqlite);
  sqlite.prepare("INSERT INTO cases (id, name, status, scope_rules_json, created_at) VALUES ('case_1', 'Case', 'active', '[]', ?)")
    .run("2026-08-24T08:00:00.000Z");
  sqlite.prepare(`
    INSERT INTO scenario_event_streams
      (run_id, case_id, definition_kind, definition_version, status, active_phase_id, revision, created_at, updated_at)
    VALUES ('run_1', 'case_1', 'web_blackbox', 1, 'running', 'scope_setup', 1, ?, ?)
  `).run("2026-08-24T08:00:00.000Z", "2026-08-24T08:00:00.000Z");
  sqlite.prepare(`
    INSERT INTO scenario_authorizations
      (id, case_id, scenario_kind, scope_json, approved_by, status, expires_at, created_at, updated_at)
    VALUES ('scope_1', 'case_1', 'web_blackbox', ?, 'operator_1', 'active', ?, ?, ?)
  `).run(
    JSON.stringify({ targets: ["https://authorized.example"], allowedActions: ["scope.read"], deniedActions: [] }),
    "2026-08-24T10:00:00.000Z", "2026-08-24T08:00:00.000Z", "2026-08-24T08:00:00.000Z",
  );
  const now = () => "2026-08-24T09:00:00.000Z";
  const vault = new SqliteEncryptedSecretVault(sqlite, Buffer.alloc(32, 11), now);
  return { sqlite, gateway: new ExecutionSessionGateway(sqlite, vault, now) };
}

afterEach(() => { while (databases.length) databases.pop()!.close(); });

describe("ExecutionSessionGateway", () => {
  it("keeps identity secrets encrypted and returns only metadata to control-plane callers", () => {
    const { sqlite, gateway } = setup();
    const identity = gateway.createIdentity({
      id: "identity_1", caseId: "case_1", name: "Authenticated user", kind: "user",
      secret: {
        headers: { Authorization: "Bearer highly-sensitive-token" },
        cookies: [{ name: "session", value: "highly-sensitive-cookie", domain: "authorized.example" }],
      },
    });
    expect(identity).not.toHaveProperty("secret");
    expect(JSON.stringify(gateway.listIdentities("case_1"))).not.toContain("highly-sensitive");
    const encrypted = sqlite.prepare("SELECT ciphertext FROM encrypted_secret_entries").pluck().get() as Buffer;
    expect(encrypted.toString("utf8")).not.toContain("highly-sensitive");
  });

  it("shares identity and evolving cookies through a Run-bound leased Session", () => {
    const { gateway } = setup();
    gateway.createIdentity({
      id: "identity_1", caseId: "case_1", name: "User", kind: "user",
      secret: { headers: { Authorization: "Bearer token" }, cookies: [{ name: "base", value: "one", domain: "authorized.example" }] },
    });
    const session = gateway.openSession({ caseId: "case_1", runId: "run_1", scopeRef: "scope_1", identityId: "identity_1" });
    gateway.updateCookies(session.id, [{ name: "rotated", value: "two", domain: "authorized.example" }]);
    const material = gateway.use(session.id, {
      workerId: "worker_1", workId: "work_1", caseId: "case_1", runId: "run_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:30:00.000Z",
    });
    expect(material.headers).toEqual({ Authorization: "Bearer token" });
    expect(material.cookies.map((cookie) => cookie.name)).toEqual(["base", "rotated"]);
    expect(material.session).toMatchObject({ lastWorkerId: "worker_1", lastWorkId: "work_1", lastLeaseId: "lease_1" });
  });

  it("freezes dependent Sessions and destroys secret material when an identity is revoked", () => {
    const { sqlite, gateway } = setup();
    gateway.createIdentity({ id: "identity_1", caseId: "case_1", name: "User", kind: "user", secret: { headers: { Authorization: "secret" }, cookies: [] } });
    const session = gateway.openSession({ caseId: "case_1", runId: "run_1", scopeRef: "scope_1", identityId: "identity_1" });
    gateway.revokeIdentity("identity_1");
    expect(gateway.listSessions("run_1")[0].status).toBe("frozen");
    expect(sqlite.prepare("SELECT COUNT(*) FROM encrypted_secret_entries WHERE ref LIKE 'identity-secret:%'").pluck().get()).toBe(0);
    expect(() => gateway.use(session.id, {
      workerId: "worker_1", workId: "work_1", caseId: "case_1", runId: "run_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:30:00.000Z",
    })).toThrow(/frozen/);
  });
});
