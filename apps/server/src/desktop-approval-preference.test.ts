import { expect, it } from "vitest";
import Fastify from "fastify";
import { createDb, getSqliteClient } from "./db/client.js";
import { FoundationHostControl } from "./foundation-host-control.js";
import { DesktopApprovalPreference, registerDesktopApprovalPreference } from "./desktop-approval-preference.js";
import { RunToolPolicy } from "./run-tool-policy.js";
import { RunWorkspace, type ExecutionToolAdapter } from "@traceforge/worker-runtime";
import type { ScenarioDefinition } from "@traceforge/orchestration-core";
import { assignment } from "../../../packages/worker-runtime/src/test-fixtures.js";

it("persists changes and the same running policy reads each new setting, never bypassing high risk", async () => {
  const sqlite = getSqliteClient(createDb(":memory:"));
  try {
    const store = new DesktopApprovalPreference(sqlite), workspace = new RunWorkspace("/tmp/live-policy", {} as ExecutionToolAdapter, () => {});
    const policy = new RunToolPolicy({ authorizationActions: [] } as unknown as ScenarioDefinition, undefined, workspace, "darwin", () => store.read().routineApprovalRequired);
    const current = assignment().assignment, write = workspace.tools().find(t => t.name === "workspace_write")!;
    expect(policy.requiresApproval(current, write)).toBe(false);
    store.save({ expectedRevision: 0, routineApprovalRequired: false });
    expect(policy.requiresApproval(current, write)).toBe(false);
    expect(new DesktopApprovalPreference(sqlite).read()).toEqual({ revision: 1, routineApprovalRequired: false });
    expect(policy.approval(current, workspace.tools().find(t => t.name === "workspace_execute")!)).toBeUndefined();
    expect(() => store.save({ expectedRevision: 0, routineApprovalRequired: true })).toThrow();
    store.save({ expectedRevision: 1, routineApprovalRequired: true });
    expect(policy.requiresApproval(current, write)).toBe(true);
  } finally { sqlite.close(); }
});

it("only accepts management writes, validates values and rejects stale updates", async () => {
  const sqlite = getSqliteClient(createDb(":memory:")), app = Fastify();
  const controls = new FoundationHostControl(app, sqlite), headers = controls.management().headers();
  registerDesktopApprovalPreference(app, new DesktopApprovalPreference(sqlite));
  try {
    const url = "/api/desktop/approval-preference";
    expect((await app.inject({ url })).statusCode).toBe(401);
    const worker = controls.worker(assignment().worker, "neutral", 1);
    expect((await app.inject({ url, headers: worker.headers() })).statusCode).toBe(403);
    expect((await app.inject({ url, method: "POST", headers, payload: { expectedRevision: 0, routineApprovalRequired: "false" } })).statusCode).toBe(400);
    expect((await app.inject({ url, method: "POST", headers, payload: { expectedRevision: 0, routineApprovalRequired: false } })).json()).toEqual({ revision: 1, routineApprovalRequired: false });
    expect((await app.inject({ url, method: "POST", headers, payload: { expectedRevision: 0, routineApprovalRequired: true } })).statusCode).toBe(409);
  } finally { await app.close(); sqlite.close(); }
});
