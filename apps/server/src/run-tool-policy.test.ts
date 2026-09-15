import { expect, it, vi } from "vitest";
import { RunToolPolicy } from "./run-tool-policy.js";
import { RunWorkspace, PolicyExecutionToolGateway, createExecutionToolRegistry, type ExecutionToolAdapter } from "@traceforge/worker-runtime";
import type { ScenarioDefinition } from "@traceforge/orchestration-core";
import type { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { assignment } from "../../../packages/worker-runtime/src/test-fixtures.js";

it("uses the pinned desktop inquiry mode without granting high-risk legacy autonomy", () => {
  let payload: Record<string, unknown> = { routineApprovalRequired: false, autonomous: true };
  const authorization = { requireScope: () => ({ scope: { payload } }), requireAction: () => ({ scopePayload: payload }) } as unknown as SqliteScenarioAuthorizationService;
  const workspace = new RunWorkspace("/tmp/inquiry-policy", {} as ExecutionToolAdapter, () => {});
  const definition = { kind: "neutral", version: 1, authorizationActions: ["workspace.execute"], toolPolicies: [{ source: "traceforge.builtin", capability: "workspace.execute", authorizationAction: "workspace.execute", profile: "run-workspace", autonomousScopeFlag: "autonomous" }] } as ScenarioDefinition;
  const policy = new RunToolPolicy(definition, authorization, workspace, "darwin"), current = assignment().assignment;
  const execute = workspace.tools().find(tool => tool.name === "workspace_execute")!;
  const write = workspace.tools().find(tool => tool.name === "workspace_write")!;
  expect(policy.requiresApproval(current, write)).toBe(false);
  expect(policy.approval(current, execute)).toBeUndefined();
  payload.routineApprovalRequired = true;
  expect(policy.requiresApproval(current, write)).toBe(true);
  expect(policy.approval(current, execute)).toBeUndefined();
  payload.routineApprovalRequired = "false";
  expect(() => policy.requiresApproval(current, write)).toThrow("Invalid");
  delete payload.routineApprovalRequired;
  expect(policy.requiresApproval(current, write)).toBe(false);
  expect(policy.approval(current, execute)?.decision).toBe("approved");
});

it("uses explicit Scope consent for autonomous execution and records the decision without expanding permissions", async () => {
  let consent: unknown = false, revoked = false;
  const authorization = { requireScope: () => ({ scope: { payload: {} } }), requireAction: vi.fn(() => { if (revoked) throw new Error("revoked"); return { scopePayload: { autonomous: consent } }; }) } as unknown as SqliteScenarioAuthorizationService;
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
it("requires a separate declared network grant and never grants it from autonomy alone", () => {
  let networkAllowed = false;
  const authorization = { requireAction(_scope: string, _case: string, action: string) {
    if (action === "workspace.network" && !networkAllowed) throw new Error("not granted");
    return { scopePayload: { autonomous: true } };
  } } as unknown as SqliteScenarioAuthorizationService;
  const workspace = new RunWorkspace("/tmp/workspace-network-policy", {} as ExecutionToolAdapter, () => {});
  const tool = workspace.tools().find(tool => tool.name === "workspace_execute")!;
  const definition = { kind: "neutral", version: 1, authorizationActions: ["workspace.execute", "workspace.network"],
    toolPolicies: [{ source: "traceforge.builtin", capability: "workspace.execute", authorizationAction: "workspace.execute", profile: "run-workspace", autonomousScopeFlag: "autonomous" }] } as ScenarioDefinition;
  const policy = new RunToolPolicy(definition, authorization, workspace, "darwin"), current = assignment().assignment;
  expect(policy.layers(current, tool)[0].profile.network).toBe("deny");
  networkAllowed = true;
  expect(policy.layers(current, tool)[0].profile.network).toBe(process.platform === "darwin" && process.arch === "arm64" ? "brokered" : "deny");
  definition.authorizationActions = ["workspace.execute"];
  expect(policy.layers(current, tool)[0].profile.network).toBe("deny");
});
it("keeps old scopes non-interactive and grants terminal access only from explicit consent",()=>{
  let consent:unknown=undefined;
  const auth={requireScope:()=>({scope:{payload:{}}}),requireAction:()=>({scopePayload:{interactiveWorkspace:consent}})} as unknown as SqliteScenarioAuthorizationService;
  const workspace=new RunWorkspace('/tmp/terminal-policy',{} as ExecutionToolAdapter,()=>{});
  const tool={...workspace.tools().find(t=>t.name==='workspace_execute')!,name:'workspace_input',providedCapabilities:['workspace.input']};
  const definition={kind:'neutral',version:1,authorizationActions:['workspace.execute'],toolPolicies:[{source:tool.source,capability:'workspace.input',authorizationAction:'workspace.execute',profile:'run-workspace'}]} as ScenarioDefinition;
  const policy=new RunToolPolicy(definition,auth,workspace,'darwin'),current=assignment().assignment;
  for(const value of [undefined,false,'true',1]){consent=value;expect(policy.layers(current,tool)[0].profile.process.interactive).toBe(false);}
  consent=true;expect(policy.layers(current,tool)[0].profile.process.interactive).toBe(process.platform==='darwin'&&process.arch==='arm64');
  expect(policy.approval(current,tool)?.decision).toBe('approved');expect(policy.layers(current,tool)[0].profile.network).toBe('deny');
});

it("records explicit continuous-input consent through the gateway without releasing the lease or granting other execution", async () => {
  let consent = true, revoked = false;
  const payload = () => ({ routineApprovalRequired: true, interactiveWorkspace: consent });
  const auth = { requireScope: () => ({ scope: { payload: payload() } }), requireAction: () => {
    if (revoked) throw new Error("revoked"); return { scopePayload: payload() };
  } } as unknown as SqliteScenarioAuthorizationService;
  const workspace = new RunWorkspace('/tmp/terminal-consent-policy', {} as ExecutionToolAdapter, () => {});
  const base = workspace.tools().find(t => t.name === 'workspace_execute')!;
  const execute = vi.fn(async () => ({ status: 'succeeded' as const, raw: 'accepted', summary: 'accepted', refs: [], retryable: false }));
  const tool = { ...base, name: 'workspace_input', providedCapabilities: ['workspace.input'], dependencyCapabilities: [], execute };
  const definition = { kind: 'neutral', version: 1, authorizationActions: ['workspace.execute'], toolPolicies: [
    { source: tool.source, capability: 'workspace.input', authorizationAction: 'workspace.execute', profile: 'run-workspace' },
  ] } as ScenarioDefinition;
  const policy = new RunToolPolicy(definition, auth, workspace, 'darwin');
  const current = assignment(); current.worker.capabilities = ['workspace.input']; current.assignment.work.requiredCapabilities = ['workspace.input'];
  const receipts = new Map();
  const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([tool]), {
    async authorize(input) { return policy.approval(input.assignment, input.tool) ?? { decision: 'pending' }; },
  }, { async get(key) { return receipts.get(key); }, async put(key, value) { receipts.set(key, value); } }, {
    allowedRisks: ['privileged'], permissionLayers: ({ assignment, tool }) => policy.layers(assignment, tool),
  });
  const invoke = (id: string) => gateway.execute({ ...current, invocation: { id, tool: tool.name, input: {}, rationale: 'Continue the owned terminal' }, idempotencyKey: id });
  expect(await invoke('input')).toMatchObject({ status: 'succeeded', metadata: { approvalReason: expect.stringContaining('continuous input') } });
  await invoke('input'); expect(execute).toHaveBeenCalledTimes(1);
  expect(policy.approval(current.assignment, base)).toBeUndefined();
  expect(policy.approval(current.assignment, { ...tool, source: 'external' })).toBeUndefined();
  consent = false; expect(await invoke('not-consented')).toMatchObject({ status: 'approval_required' });
  consent = true; revoked = true; await expect(invoke('revoked')).rejects.toThrow('policy');
  expect(execute).toHaveBeenCalledTimes(1);
});
