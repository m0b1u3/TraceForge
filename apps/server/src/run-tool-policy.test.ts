import { expect, it, vi } from "vitest";
import { RunToolPolicy } from "./run-tool-policy.js";
import { RunWorkspace, PolicyExecutionToolGateway, createExecutionToolRegistry, type ExecutionToolAdapter } from "@traceforge/worker-runtime";
import type { ScenarioDefinition } from "@traceforge/orchestration-core";
import type { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { assignment } from "../../../packages/worker-runtime/src/test-fixtures.js";
import { readFileSync } from "node:fs";
import { tools as scenarioTools } from "../../../scenarios/web-blackbox/runtime/contracts.mjs";

it("offers an installed browser tool only while its Host and Run are active", async () => {
  const definition = JSON.parse(readFileSync(new URL("../../../scenarios/web-blackbox/scenario.json", import.meta.url), "utf8")).definition as ScenarioDefinition;
  let ready = true, revoked = false;
  const authorization = { requireAction: () => { if (revoked) throw new Error("revoked"); return { scopePayload: { unrestricted: true } }; } } as unknown as SqliteScenarioAuthorizationService;
  const spec = scenarioTools.find(tool => tool.name === "web.browser.inspect")!;
  const execute = vi.fn(async (_input, context) => {
    expect(context.effectivePermissions).toMatchObject({ network: "brokered", process: { access: "sandboxed", interactive: false, background: false }, filesystem: { read: [], write: [] } });
    return { status: "succeeded" as const, raw: "observed", summary: "observed", refs: [], retryable: false };
  });
  const tool = { ...spec, execute } as ExecutionToolAdapter;
  const policy = new RunToolPolicy(definition, authorization, undefined, "darwin", () => ready);
  const current = assignment(); current.worker.capabilities = [...tool.providedCapabilities]; current.assignment.work.requiredCapabilities = [...tool.providedCapabilities];
  const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([tool]), { async authorize() { return { decision: "approved" }; } },
    { async get() { return undefined; }, async put() {} }, { allowedRisks: ["read_only", "bounded_write"], permissionLayers: ({ assignment, tool }) => policy.layers(assignment, tool) });
  expect((await gateway.catalog(current.worker, current.assignment)).tools.map(item => item.name)).toContain(tool.name);
  await gateway.execute({ ...current, invocation: { id: "browser", tool: tool.name, input: { url: "https://first.example/" }, rationale: "Observe page" }, idempotencyKey: "browser" });
  expect(execute).toHaveBeenCalledTimes(1);
  ready = false; expect((await gateway.catalog(current.worker, current.assignment)).tools).toEqual([]);
  ready = true; revoked = true; expect((await gateway.catalog(current.worker, current.assignment)).tools).toEqual([]);
});

it("approves installed privileged tools continuously and records the decision", async () => {
  let revoked = false;
  const payload = { unrestricted: true, directWorkspaceNetwork: true, interactiveWorkspace: true };
  const authorization = {
    requireScope: () => { if (revoked) throw new Error("revoked"); return { scope: { payload } }; },
    requireAction: () => { if (revoked) throw new Error("revoked"); return { scopePayload: payload }; },
  } as unknown as SqliteScenarioAuthorizationService;
  const workspace = new RunWorkspace("/tmp/traceforge-policy-test", {} as ExecutionToolAdapter, () => {});
  const definition = { kind: "neutral", version: 1, authorizationActions: ["workspace.execute"],
    toolPolicies: [{ source: "traceforge.builtin", capability: "workspace.execute", authorizationAction: "workspace.execute", profile: "run-workspace" }] } as ScenarioDefinition;
  const policy = new RunToolPolicy(definition, authorization, workspace, "darwin");
  const execute = vi.fn(async () => ({ status: "succeeded" as const, raw: "done", summary: "done", refs: [], retryable: false }));
  const tool = { ...workspace.tools().find(item => item.name === "workspace_execute")!, dependencyCapabilities: [], execute };
  const current = assignment(); current.worker.capabilities = ["workspace.execute"]; current.assignment.work.requiredCapabilities = ["workspace.execute"];
  const receipts = new Map();
  const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([tool]), { async authorize(input) { return policy.approval(input.assignment, input.tool) ?? { decision: "pending" }; } },
    { async get(key) { return receipts.get(key); }, async put(key, result) { receipts.set(key, result); } },
    { allowedRisks: ["privileged"], permissionLayers: ({ assignment, tool }) => policy.layers(assignment, tool) });
  const invoke = (id: string) => gateway.execute({ ...current, invocation: { id, tool: tool.name, input: {}, rationale: "Run installed tool" }, idempotencyKey: id });
  expect(policy.requiresApproval(current.assignment, tool)).toBe(false);
  expect(policy.approval(current.assignment, tool)).toMatchObject({ decision: "approved" });
  expect(policy.layers(current.assignment, tool)[0].profile.network).toBe(process.platform === "darwin" && process.arch === "arm64" ? "direct" : "deny");
  expect(await invoke("first")).toMatchObject({ status: "succeeded", metadata: { approvalReason: "Installed tool available to this active Run" } });
  await invoke("second"); await invoke("first"); expect(execute).toHaveBeenCalledTimes(2);
  revoked = true; await expect(invoke("revoked")).rejects.toThrow("policy"); expect(execute).toHaveBeenCalledTimes(2);
});

it("rejects ambiguous tool profiles and unavailable native execution", () => {
  const workspace = new RunWorkspace("/tmp/traceforge-policy-test", {} as ExecutionToolAdapter, () => {});
  const tool = workspace.tools().find(item => item.name === "workspace_execute")!;
  const definition = { kind: "neutral", version: 1, authorizationActions: ["workspace.execute"], toolPolicies: [1, 2].map(() =>
    ({ source: tool.source, capability: "workspace.execute", profile: "run-workspace", authorizationAction: "workspace.execute" })) } as ScenarioDefinition;
  const policy = new RunToolPolicy(definition, undefined, workspace, "darwin");
  expect(() => policy.layers(assignment().assignment, tool)).toThrow("Ambiguous");
  definition.toolPolicies = undefined;
  expect(policy.layers(assignment().assignment, tool)[0].profile.process.access).toBe("deny");
});
