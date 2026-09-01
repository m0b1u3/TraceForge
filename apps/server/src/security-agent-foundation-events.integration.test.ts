import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmProvider } from "@traceforge/llm";
import { WEB_BLACKBOX_CAPABILITIES, WEB_BLACKBOX_HOST_CAPABILITIES } from "@traceforge/scenario-web-blackbox";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerSecurityAgentFoundation } from "./security-agent-foundation.js";
import { WEB_BLACKBOX_PACKAGE } from "@traceforge/scenario-web-blackbox";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { foundationHostControl } from "./foundation-host-control.js";

const unavailableProvider: LlmProvider = {
  async extractJson() { throw new Error("provider is intentionally unavailable"); },
  async runTools() { throw new Error("provider is intentionally unavailable"); },
};

describe("security agent foundation protocol events", () => {
  it("projects control-plane cancellation into a replayable system Turn", async () => {
    const app = Fastify();
    const db = createDb(":memory:");
    const sqlite = getSqliteClient(db);
    const root = mkdtempSync(join(tmpdir(), "traceforge-agent-events-"));
    sqlite.prepare("INSERT INTO cases (id, name, status, scope_rules_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("case_1", "Authorized assessment", "active", "{}", "2026-08-25T08:00:00.000Z");
    registerSecurityAgentFoundation(app, sqlite, unavailableProvider, root, () => false, {
      scenarioPackageRegistry: new ScenarioPackageRegistry([WEB_BLACKBOX_PACKAGE]),
      scenarioHostCapabilities: {
        [WEB_BLACKBOX_HOST_CAPABILITIES.sessions]: {},
        [WEB_BLACKBOX_HOST_CAPABILITIES.traffic]: {},
      },
      scenarioPackageTrust:{allowUnreviewedDevelopmentPackages:true},
      autoScheduleIntervalMs: 60_000,
    });
    await app.ready();
    const management=foundationHostControl(app).management();
    try {
      const authorization = await app.inject({
        method: "POST", url: "/api/scenarios/authorizations",headers:management.headers(),
        payload: {
          id: "scope_1", caseId: "case_1", scenarioKind: "web_blackbox",
          scope: {
            targets: ["https://authorized.example"],
            allowedActions: [WEB_BLACKBOX_CAPABILITIES.scopeRead, WEB_BLACKBOX_CAPABILITIES.evidenceWrite],
            deniedActions: [],
          },
          approvedBy: "operator_1", expiresAt: "2027-08-25T09:00:00.000Z",
        },
      });
      expect(authorization.statusCode).toBe(201);
      const started = await app.inject({
        method: "POST", url: "/api/scenarios/runs",headers:management.headers(),
        payload: {
          commandId: "start_1", runId: "run_1", caseId: "case_1", goal: "Assess authorized scope",
          scopeRef: "scope_1", scenarioKind: "web_blackbox", definitionVersion: 1,
        },
      });
      expect(started.statusCode).toBe(201);
      const cancelled = await app.inject({
        method: "POST", url: "/api/scenarios/runs/run_1/cancel",headers:management.headers(),
        payload: { commandId: "cancel_1", expectedRevision: 1, reason: "Operator stopped the Run" },
      });
      expect(cancelled.statusCode).toBe(200);

      const replay = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_1/agent-events?after=0&limit=10",headers:management.headers() });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().events.map((event: { method: string }) => event.method)).toEqual([
        "turn/started", "item/completed", "turn/completed",
        "turn/started", "item/completed", "turn/completed",
      ]);
      expect(replay.json().events[1].params.item).toMatchObject({ type: "controlChange", eventType: "run_started" });
      expect(replay.json().events[4].params.item).toMatchObject({ type: "controlChange", eventType: "run_cancelled" });
    } finally {
      await app.close();
      sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
