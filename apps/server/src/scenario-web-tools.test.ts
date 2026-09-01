import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { BrokeredHttpRequest, BrokeredHttpResponse } from "@traceforge/execution-node";
import { satisfiesPermissionRequirements } from "@traceforge/orchestration-core";
import { createDb, getSqliteClient } from "./db/client.js";
import {
  ScenarioBrowserObserveTool,
  ScenarioHttpRequestTool,
  ScenarioScopeSnapshotTool,
  ScenarioTrafficSnapshotTool,
  type ScenarioBrowserTransport,
} from "@traceforge/scenario-web-blackbox";
import { ExecutionSessionGateway, SqliteEncryptedSecretVault } from "./execution-session-gateway.js";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { SqliteScenarioTrafficStore } from "./scenario-traffic-store.js";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { WEB_BLACKBOX_PACKAGE } from "@traceforge/scenario-web-blackbox";
import type { GovernedExecutionPort } from "@traceforge/worker-runtime";

const databases: Database.Database[] = [];
const context = {
  workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
  leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:30:00.000Z", idempotencyKey: "effect:call_1",
  effectivePermissions: {
    version: 1 as const,
    platform: (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux") as "windows" | "linux" | "darwin",
    filesystem: { read: [], write: [], deny: [] },
    network: "brokered" as const,
    process: { access: "deny" as const, interactive: false, background: false },
    secrets: "handles_only" as const,
    sources: ["test"],
  },
};

function brokerResponse(request: BrokeredHttpRequest): BrokeredHttpResponse {
  return {
    receipt: {
      id: "netreceipt_1", nodeId: "node_1", requestId: request.requestId,
      attribution: request.attribution, authorizationRef: "scope_1",
      authorizationAction: request.authorizationAction, url: request.url, method: request.method,
      status: 302, requestBytes: 0, responseBytes: 8, responseBodyTruncated: false,
      permissionProfileFingerprint: "0".repeat(64), redirectFollowed: false,
      startedAt: "2026-08-24T09:01:00.000Z", completedAt: "2026-08-24T09:01:00.000Z",
    },
    status: 302,
    headers: [
      { name: "location", value: "https://outside.example/" },
      { name: "content-type", value: "text/plain" },
      { name: "set-cookie", value: "rotated=secret-cookie" },
    ],
    bodyBase64: Buffer.from("redirect").toString("base64"),
    responseBytes: 8,
    bodyTruncated: false,
    replayed: false,
  };
}

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
  const authorization = new SqliteScenarioAuthorizationService(
    sqlite,
    new ScenarioPackageRegistry([WEB_BLACKBOX_PACKAGE]),
    () => Date.parse("2026-08-24T09:00:00.000Z"),
  );
  const traffic = new SqliteScenarioTrafficStore(sqlite);
  authorization.pin("scope_1","case_1",{id:WEB_BLACKBOX_PACKAGE.id,version:WEB_BLACKBOX_PACKAGE.version,schemaRevision:WEB_BLACKBOX_PACKAGE.schemaRevision},0);
  return { sqlite, sessions, authorization, traffic };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (databases.length) databases.pop()!.close();
});

describe("scenario Web execution tools", () => {
  it("exposes brokered HTTP but keeps the direct Browser transport outside the brokered-only profile", () => {
    const { authorization, sessions, traffic } = setup();
    const executionNode = { requestHttp: vi.fn() } as unknown as GovernedExecutionPort;
    const http = new ScenarioHttpRequestTool(authorization, sessions, traffic, executionNode);
    const browser = new ScenarioBrowserObserveTool(authorization, sessions, traffic);
    expect(satisfiesPermissionRequirements(context.effectivePermissions, http.permissionRequirements)).toBe(true);
    expect(satisfiesPermissionRequirements(context.effectivePermissions, browser.permissionRequirements)).toBe(false);
  });

  it("executes an in-scope HTTP request, does not follow redirects, and records an attributed receipt", async () => {
    const { sqlite, authorization, sessions, traffic } = setup();
    const identity = sessions.createIdentity({
      id: "identity_1", caseId: "case_1", name: "User", kind: "user",
      secret: { headers: { Authorization: "Bearer secret" }, cookies: [] },
    });
    const session = sessions.openSession({ caseId: "case_1", runId: "run_1", scopeRef: "scope_1", identityId: identity.id });
    const requestHttp = vi.fn(async (request: BrokeredHttpRequest) => {
      expect(request.url).toBe("https://authorized.example/api");
      expect(request.permissions.network).toBe("brokered");
      expect(request.headers.Authorization).toBe("Bearer secret");
      return brokerResponse(request);
    });
    const executionNode = { requestHttp: (input: Parameters<GovernedExecutionPort["requestHttp"]>[0]) => requestHttp({
      ...input, requestId: context.idempotencyKey,
      attribution: { ...context, actionId: context.idempotencyKey }, permissions: context.effectivePermissions,
    }) } as GovernedExecutionPort;
    const result = await new ScenarioHttpRequestTool(authorization, sessions, traffic, executionNode, () => "2026-08-24T09:01:00.000Z")
      .execute({ sessionId: session.id, url: "https://authorized.example/api", headers: { Accept: "text/plain" } }, context);

    expect(result.status).toBe("succeeded");
    expect(result.summary).toContain("status 302");
    expect(result.refs[0]).toMatch(/^traffic:/);
    const trafficId = result.refs[0]!.slice("traffic:".length);
    expect(result.raw).not.toContain("secret-cookie");
    expect(requestHttp).toHaveBeenCalledOnce();
    expect(result.refs).toContain("network-receipt:netreceipt_1");
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
    expect(sqlite.prepare(`
      SELECT case_id, run_id, work_id, worker_id, authorization_ref, traffic_id, redirect_followed
      FROM execution_network_receipts WHERE id = 'netreceipt_1'
    `).get()).toEqual({
      case_id: "case_1", run_id: "run_1", work_id: "work_1", worker_id: "worker_1",
      authorization_ref: "scope_1", traffic_id: trafficId,
      redirect_followed: 0,
    });
  });

  it("rejects out-of-scope and revoked execution before touching the transport", async () => {
    const { sqlite, authorization, sessions, traffic } = setup();
    const session = sessions.openSession({ caseId: "case_1", runId: "run_1", scopeRef: "scope_1" });
    const requestHttp = vi.fn();
    const tool = new ScenarioHttpRequestTool(authorization, sessions, traffic, { requestHttp } as unknown as GovernedExecutionPort);
    await expect(tool.execute({ sessionId: session.id, url: "https://outside.example/" }, context)).rejects.toThrow(/outside authorization/);
    sqlite.prepare("UPDATE scenario_authorizations SET status = 'revoked' WHERE id = 'scope_1'").run();
    await expect(tool.execute({ sessionId: session.id, url: "https://authorized.example/" }, context)).rejects.toThrow(/expired or revoked/);
    expect(requestHttp).not.toHaveBeenCalled();
  });

  it("exposes only authorization-bound scope and Case traffic", async () => {
    const { sqlite, authorization, traffic: trafficStore } = setup();
    sqlite.prepare(`
      INSERT INTO traffic_entries
        (id, case_id, run_id, url, method, request_headers_json, response_status, created_at)
      VALUES ('traf_1', 'case_1', 'run_1', 'https://authorized.example/', 'GET', '{}', 200, '2026-08-24T09:00:00.000Z'),
             ('traf_other', 'case_2', 'run_other', 'https://other.example/', 'GET', '{}', 200, '2026-08-24T09:00:00.000Z')
    `).run();
    const scope = await new ScenarioScopeSnapshotTool(authorization).execute({}, context);
    const traffic = await new ScenarioTrafficSnapshotTool(authorization, trafficStore).execute({ limit: 10 }, context);
    expect(scope.refs).toEqual(["authorization:scope_1"]);
    expect(traffic.refs).toEqual(["traffic:traf_1"]);
  });

  it("uses an isolated browser transport and filters observations through the same scope guard", async () => {
    const { sqlite, authorization, sessions, traffic } = setup();
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
    const result = await new ScenarioBrowserObserveTool(authorization, sessions, traffic, transport, () => "2026-08-24T09:01:00.000Z")
      .execute({ sessionId: session.id, url: "https://authorized.example/" }, context);
    expect(result.status).toBe("succeeded");
    expect(result.refs[0]).toMatch(/^traffic:/);
    expect(transport).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT attribution_source FROM traffic_entries").pluck().get()).toBe("browser");
  });
});
