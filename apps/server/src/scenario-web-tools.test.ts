import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb, getSqliteClient } from "./db/client.js";
import {
  ScenarioAuthorizationGuard,
  ScenarioBrowserObserveTool,
  ScenarioHttpRequestTool,
  ScenarioScopeSnapshotTool,
  ScenarioTrafficSnapshotTool,
  type ScenarioBrowserTransport,
  type ScenarioHttpTransport,
} from "./scenario-web-tools.js";
import { ExecutionSessionGateway, SqliteEncryptedSecretVault } from "./execution-session-gateway.js";

const databases: Database.Database[] = [];
const context = {
  workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
  leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:30:00.000Z", idempotencyKey: "effect:call_1",
};

function setup(actions = ["scope.read", "web.traffic.read", "web.request.replay", "web.browser.navigate"]) {
  const sqlite = getSqliteClient(createDb(":memory:"));
  databases.push(sqlite);
  sqlite.prepare("INSERT INTO cases (id, name, status, scope_rules_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("case_1", "Authorized assessment", "active", "[]", "2026-08-24T08:00:00.000Z");
  sqlite.prepare(`
    INSERT INTO scenario_event_streams
      (run_id, case_id, definition_kind, definition_version, status, active_phase_id, revision, created_at, updated_at)
    VALUES ('run_1', 'case_1', 'web_blackbox', 1, 'running', 'scope_setup', 1, '2026-08-24T08:00:00.000Z', '2026-08-24T08:00:00.000Z')
  `).run();
  sqlite.prepare(`
    INSERT INTO scenario_authorizations
      (id, case_id, scenario_kind, scope_json, approved_by, status, expires_at, created_at, updated_at)
    VALUES (?, ?, 'web_blackbox', ?, 'operator_1', 'active', ?, ?, ?)
  `).run(
    "scope_1",
    "case_1",
    JSON.stringify({ targets: ["https://authorized.example"], allowedActions: actions, deniedActions: [] }),
    "2026-08-24T10:00:00.000Z",
    "2026-08-24T08:00:00.000Z",
    "2026-08-24T08:00:00.000Z",
  );
  const sessions = new ExecutionSessionGateway(
    sqlite,
    new SqliteEncryptedSecretVault(sqlite, Buffer.alloc(32, 7), () => "2026-08-24T09:00:00.000Z"),
    () => "2026-08-24T09:00:00.000Z",
  );
  return { sqlite, sessions, guard: new ScenarioAuthorizationGuard(sqlite, () => Date.parse("2026-08-24T09:00:00.000Z")) };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (databases.length) databases.pop()!.close();
});

describe("scenario Web execution tools", () => {
  it("executes an in-scope HTTP request, does not follow redirects, and records an attributed receipt", async () => {
    const { sqlite, guard, sessions } = setup();
    const identity = sessions.createIdentity({
      id: "identity_1", caseId: "case_1", name: "User", kind: "user",
      secret: { headers: { Authorization: "Bearer secret" }, cookies: [] },
    });
    const session = sessions.openSession({ caseId: "case_1", runId: "run_1", scopeRef: "scope_1", identityId: identity.id });
    const transport = vi.fn<ScenarioHttpTransport>(async (request) => {
      expect(request.url).toBe("https://authorized.example/api");
      return {
        status: 302,
        headers: { location: "https://outside.example/", "content-type": "text/plain", "set-cookie": "rotated=secret-cookie" },
        body: "redirect",
        cookies: [{ name: "rotated", value: "secret-cookie", domain: "authorized.example" }],
      };
    });
    const result = await new ScenarioHttpRequestTool(sqlite, guard, sessions, transport, () => "2026-08-24T09:01:00.000Z")
      .execute({ sessionId: session.id, url: "https://authorized.example/api", headers: { Accept: "text/plain" } }, context);

    expect(result.status).toBe("succeeded");
    expect(result.summary).toContain("status 302");
    expect(result.refs[0]).toMatch(/^traffic:/);
    expect(result.raw).not.toContain("secret-cookie");
    expect(transport).toHaveBeenCalledOnce();
    const row = sqlite.prepare("SELECT run_id, request_headers_json, response_status FROM traffic_entries").get() as {
      run_id: string; request_headers_json: string; response_status: number;
    };
    expect(row.run_id).toBe("run_1");
    expect(JSON.parse(row.request_headers_json)).toEqual({ Authorization: "[REDACTED]", Accept: "text/plain" });
    expect(row.response_status).toBe(302);
    const material = sessions.use(session.id, context);
    expect(material.cookies).toContainEqual(expect.objectContaining({ name: "rotated", value: "secret-cookie" }));
    const responseHeaders = sqlite.prepare("SELECT response_headers_json FROM traffic_entries").pluck().get() as string;
    expect(JSON.parse(responseHeaders)["set-cookie"]).toBe("[REDACTED]");
  });

  it("rejects out-of-scope and revoked execution before touching the transport", async () => {
    const { sqlite, guard, sessions } = setup();
    const session = sessions.openSession({ caseId: "case_1", runId: "run_1", scopeRef: "scope_1" });
    const transport = vi.fn<ScenarioHttpTransport>();
    const tool = new ScenarioHttpRequestTool(sqlite, guard, sessions, transport);
    await expect(tool.execute({ sessionId: session.id, url: "https://outside.example/" }, context)).rejects.toThrow(/outside authorization/);
    sqlite.prepare("UPDATE scenario_authorizations SET status = 'revoked' WHERE id = 'scope_1'").run();
    await expect(tool.execute({ sessionId: session.id, url: "https://authorized.example/" }, context)).rejects.toThrow(/expired or revoked/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("exposes only authorization-bound scope and Case traffic", async () => {
    const { sqlite, guard } = setup();
    sqlite.prepare(`
      INSERT INTO traffic_entries
        (id, case_id, run_id, url, method, request_headers_json, response_status, created_at)
      VALUES ('traf_1', 'case_1', 'run_1', 'https://authorized.example/', 'GET', '{}', 200, '2026-08-24T09:00:00.000Z'),
             ('traf_other', 'case_2', 'run_other', 'https://other.example/', 'GET', '{}', 200, '2026-08-24T09:00:00.000Z')
    `).run();
    const scope = await new ScenarioScopeSnapshotTool(guard).execute({}, context);
    const traffic = await new ScenarioTrafficSnapshotTool(sqlite, guard).execute({ limit: 10 }, context);
    expect(scope.refs).toEqual(["authorization:scope_1"]);
    expect(traffic.refs).toEqual(["traffic:traf_1"]);
  });

  it("uses an isolated browser transport and filters observations through the same scope guard", async () => {
    const { sqlite, guard, sessions } = setup();
    const session = sessions.openSession({ caseId: "case_1", runId: "run_1", scopeRef: "scope_1" });
    const transport = vi.fn<ScenarioBrowserTransport>(async (url, allowed, material) => {
      expect(url).toBe("https://authorized.example/");
      expect(material).toEqual({ headers: {}, cookies: [] });
      expect(allowed("https://authorized.example/next")).toBe(true);
      expect(allowed("https://outside.example/")).toBe(false);
      return {
        finalUrl: "https://authorized.example/",
        title: "Authorized",
        text: "Rendered observation",
        links: ["https://authorized.example/next"],
        status: 200,
      };
    });
    const result = await new ScenarioBrowserObserveTool(sqlite, guard, sessions, transport, () => "2026-08-24T09:01:00.000Z")
      .execute({ sessionId: session.id, url: "https://authorized.example/" }, context);
    expect(result.status).toBe("succeeded");
    expect(result.refs[0]).toMatch(/^traffic:/);
    expect(transport).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT attribution_source FROM traffic_entries").pluck().get()).toBe("browser");
  });
});
