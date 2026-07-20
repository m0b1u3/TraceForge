import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { makeCompareIdentityTrafficTool } from "@traceforge/extension";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { IdentityStore } from "./stores/identity-store.js";
import { TrafficStore } from "./stores/traffic-store.js";

describe("identity-aware traffic with real SQLite and HTTP", () => {
  it("versions plaintext identity state and preserves cross-identity replay evidence", async () => {
    const server = createServer((request, response) => {
      const isAdmin = request.headers.authorization === "Bearer admin-token";
      response.writeHead(isAdmin ? 200 : 403, { "content-type": "application/json" });
      response.end(JSON.stringify(isAdmin ? { role: "admin", secret: "visible" } : { error: "forbidden" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const db = createDb(":memory:");
      const identities = new IdentityStore(db);
      const traffic = new TrafficStore(db);
      const bus = new EventBus();
      const user = identities.create("case_1", {
        name: "User A",
        kind: "user",
        status: "active",
        credentials: { username: "alice", password: "plaintext-password" },
        headers: { Authorization: "Bearer user-token" },
        cookies: [],
      });
      const admin = identities.create("case_1", {
        name: "Administrator",
        kind: "admin",
        status: "active",
        credentials: { token: "admin-token" },
        headers: { Authorization: "Bearer admin-token" },
        cookies: [],
      });
      const updatedUser = identities.update(user.id, {
        headers: { Authorization: "Bearer user-token-v2" },
      });
      expect(updatedUser?.version).toBe(2);
      expect(updatedUser?.credentials.password).toBe("plaintext-password");

      const sourceId = "traffic_source";
      traffic.add({
        id: sourceId,
        caseId: "case_1",
        runId: "run_1",
        identityId: null,
        identityVersion: null,
        attributionSource: "manual",
        parentTrafficId: null,
        url: `http://127.0.0.1:${port}/admin`,
        method: "GET",
        requestHeaders: {},
        requestBody: null,
        responseStatus: null,
        responseBody: null,
        createdAt: new Date().toISOString(),
      });

      const tool = makeCompareIdentityTrafficTool(
        [{ caseId: "case_1", allowHosts: [`127.0.0.1:${port}`], denyHosts: [] }],
        traffic,
        identities,
        undefined,
        "case_1",
        traffic,
        (event) => bus.emit(event),
        "run_1",
      );
      const result = await tool.execute({
        trafficId: sourceId,
        leftIdentityId: user.id,
        rightIdentityId: admin.id,
      });

      expect(result.ok).toBe(true);
      const derived = traffic.listByCase("case_1").filter((entry) => entry.parentTrafficId === sourceId);
      expect(derived).toHaveLength(2);
      expect(derived.map((entry) => entry.identityId)).toEqual(expect.arrayContaining([user.id, admin.id]));
      expect(derived.find((entry) => entry.identityId === user.id)?.identityVersion).toBe(2);
      expect(derived.find((entry) => entry.identityId === admin.id)?.responseStatus).toBe(200);
      expect(derived.find((entry) => entry.identityId === user.id)?.responseStatus).toBe(403);
      expect(result.content).toContain('"statusChanged": true');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
