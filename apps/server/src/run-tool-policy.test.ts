import { expect, it, vi } from "vitest";
import { RunToolPolicy } from "./run-tool-policy.js";
import { RunWorkspace, PolicyExecutionToolGateway, createExecutionToolRegistry, type ExecutionToolAdapter } from "@traceforge/worker-runtime";
import type { ScenarioDefinition } from "@traceforge/orchestration-core";
import type { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { assignment } from "../../../packages/worker-runtime/src/test-fixtures.js";

it("uses explicit Scope consent for autonomous execution and records the decision without expanding permissions", async () => {
  let consent: unknown = false, revoked = false;
  const authorization = { requireAction: vi.fn(() => { if (revoked) throw new Error("revoked"); return { scopePayload: { autonomous: consent } }; }) } as unknown as SqliteScenarioAuthorizationService;
  const definition = { kind: "neutral", version: 1, authorizationActions: ["workspace.execute"], toolPolicies: [{ source: "traceforge.builtin", capability: "workspace.execute", authorizationAction: "workspace.execute", profile: "run-workspace", autonomousScopeFlag: "autonomous" }] } as ScenarioDefinition;
  const workspace = new RunWorkspace("/tmp/traceforge-policy-test", {} as ExecutionToolAdapter, () => {});
  const policy = new RunToolPolicy(definition, authorization, workspace, "darwin");
  const execute = vi.fn(async () => ({ status: "succeeded" as const, raw: "done", summary: "done", refs: [], retryable: false }));
  const tool = { ...workspace.tools().find(tool => tool.name === "workspace_execute")!, dependencyCapabilities: [], execute };
  const current = assignment(); current.worker.capabilities = ["workspace.execute"]; current.assignment.work.requiredCapabilities = ["workspace.execute"];
  const receipts = new Map();
  const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([tool]), { async authorize(input) { return policy.approval(input.assignment, input.tool) ?? { decision: "pending" }; } },
    { async get(key) { return receipts.get(key); }, async put(key, result) { receipts.set(key, result); } },
    { allowedRisks: ["privileged"], permissionLayers: ({ assignment, tool }) => policy.layers(assignment, tool) });
  const invoke = (id: string) => gateway.execute({ ...current, invocation: { id, tool: tool.name, input: {}, rationale: "Neutral offline operation" }, idempotencyKey: id });
  expect(await invoke("ask")).toMatchObject({ status: "approval_required" }); expect(execute).not.toHaveBeenCalled();
  for (const value of ["true", [true], 1]) { consent = value; expect(policy.approval(current.assignment, tool)).toBeUndefined(); }
  consent = true;
  const result = await invoke("first"); expect(result).toMatchObject({ status: "succeeded", metadata: { approvalReason: expect.stringContaining("explicitly grants"), effectivePermissions: { network: "deny", secrets: "deny", process: { access: "sandboxed" } } } });
  await invoke("second"); await invoke("first"); expect(execute).toHaveBeenCalledTimes(2);
  expect(policy.approval(current.assignment, { ...tool, source: "untrusted.provider" })).toBeUndefined();
  expect(policy.approval(current.assignment, { ...tool, name: "process_execute" })).toBeUndefined();
  revoked = true; await expect(invoke("revoked")).rejects.toThrow("policy"); expect(execute).toHaveBeenCalledTimes(2);
});

it("keeps old packages on manual approval and rejects ambiguous or mismatched source policies", () => {
  const workspace = new RunWorkspace("/tmp/traceforge-policy-test", {} as ExecutionToolAdapter, () => {}), tool = workspace.tools().find(tool => tool.name === "workspace_execute")!;
  const current = assignment();
  const definition = { kind: "neutral", version: 1, authorizationActions: ["workspace.execute"] } as ScenarioDefinition;
  const policy = new RunToolPolicy(definition, undefined, workspace, "darwin");
  expect(policy.approval(current.assignment, tool)).toBeUndefined();
  expect(policy.layers(current.assignment, tool)[0].profile.process.access).toBe("deny");
  definition.toolPolicies = [1, 2].map(() => ({ source: tool.source, capability: "workspace.execute", profile: "run-workspace", authorizationAction: "workspace.execute" }));
  expect(() => policy.layers(current.assignment, tool)).toThrow("Ambiguous");
});
