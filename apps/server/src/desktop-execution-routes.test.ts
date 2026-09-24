import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { ScenarioDefinitionRegistry } from "@traceforge/orchestration-core";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import { registerDesktopExecutionRoutes, type DesktopExecutionPort } from "./desktop-execution-routes.js";
import { registerScenarioRoutes } from "./scenario-routes.js";
import { webBlackboxControlPlanePackage } from "./test-fixtures/web-blackbox-control-plane-package.js";
import { FoundationHostControl } from "./foundation-host-control.js";
import { ExecutionController } from "../../web/renderer/execution-controller.js";
import { createConversationBridge } from "../../desktop/src/conversation-bridge.js";
import { AuthorizationFormSchema, buildAuthorizationScope } from "@traceforge/shared/authorization-form";
import { registerScenarioAgentEventRoutes, SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { WEB_BLACKBOX_CAPABILITIES } from "./test-fixtures/web-blackbox-descriptor.js";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";
import { createConversationTaskPort } from "./conversation-task-port.js";
import {createDesktopTaskStart} from "./desktop-task-start.js";
import { ConversationWorkspaces } from "./conversation-workspaces.js";
import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanups: Array<() => Promise<void>> = [];
it("starts the saved user request through real scope and Run routes without another approval form",async()=>{
  const f=await fixture(),conversationId=f.conversation.id;
  const request=async(path:string,body?:Record<string,unknown>)=>{const r=await f.call(path,body);return {status:r.statusCode,body:r.json()};};
  const port=createConversationTaskPort(f.sql,request,createDesktopTaskStart(request,()=>null));
  const call={id:"start",name:"task_request",input:{scenarioKind:f.command.scenarioKind,definitionVersion:f.command.definitionVersion}};
  const result=await port.execute(conversationId,"message",call,new AbortController().signal);
  expect(result).toMatchObject({state:"started",executed:true});
  const catalog=(await f.call(`${f.base}/execution`)).json();expect(catalog.runs).toHaveLength(1);
  expect(catalog.runs[0]).toMatchObject({messageCommandId:"message"});
  expect(catalog.scopes[0].scope.payload??catalog.scopes[0].scope).toMatchObject({asynchronousWorkspace:true});
  await port.execute(conversationId,"message",call,new AbortController().signal);
  expect((await f.call(`${f.base}/execution`)).json().runs).toHaveLength(1);
});
it("exposes installed task forms for settings without dispatching",async()=>{
  const f=await fixture();const response=await f.call("/api/desktop/task-definitions");
  expect(response.statusCode).toBe(200);expect(response.json()).toEqual(expect.arrayContaining([expect.objectContaining({kind:f.command.scenarioKind,authorizationForm:expect.any(Object)})]));
});
it("creates a private directory with the conversation and binds subsequent Runs before dispatch",async()=>{
  const f=await fixture();
  const directory=f.workspaces.ensure(f.conversation.id,f.conversation.caseId);
  expect(existsSync(directory)).toBe(true);
  expect((await f.call("/api/desktop/conversations",{commandId:"create",title:"Neutral assessment"})).json().id).toBe(f.conversation.id);
  await f.call(`${f.base}/execution/authorize`,f.authorization);
  const first=(await f.call(`${f.base}/execution`,f.command)).json().runId;
  await f.call(`${f.base}/messages`,{commandId:"next",text:"Continue with existing files"});
  const second=(await f.call(`${f.base}/execution`,{...f.command,commandId:"next-dispatch",messageCommandId:"next"})).json().runId;
  expect(first).toBeTruthy();expect(second).toBeTruthy();expect(second).not.toBe(first);
  expect(f.workspaces.root(f.conversation.caseId,first)).toBe(directory);
  expect(f.workspaces.root(f.conversation.caseId,second)).toBe(directory);
  const other=(await f.call("/api/desktop/conversations",{commandId:"other",title:"Other conversation"})).json();
  expect(f.workspaces.ensure(other.id,other.caseId)).not.toBe(directory);
  expect(()=>f.workspaces.key(other.caseId,first)).toThrow("ownership");
});
it("conversation task proposal joins the governed authorization and Run routes",async()=>{
  const f=await fixture(),conversationId=f.base.split("/").at(-1)!;
  const task=createConversationTaskPort(f.sql,async(path,body)=>{const result=await f.call(path,body);return {status:result.statusCode,body:result.json()};});
  const proposal=await task.execute(conversationId,"message",{id:"call",name:"task_request",input:{scenarioKind:f.command.scenarioKind,definitionVersion:f.command.definitionVersion}},new AbortController().signal);
  expect(proposal).toMatchObject({state:"awaiting_user_review",executed:false});
  expect((await f.call(`${f.base}/execution`)).json().runs).toHaveLength(0);
  expect((await f.call(`${f.base}/execution`,f.command)).statusCode).not.toBe(201);
  expect((await f.call(`${f.base}/execution/authorize`,f.authorization)).statusCode).toBe(201);
  const started=await f.call(`${f.base}/execution`,{...f.command,commandId:"confirmed-dispatch"});
  expect([200,201]).toContain(started.statusCode);
  const catalog=(await f.call(`${f.base}/execution`)).json();
  expect(catalog.runs).toHaveLength(1);expect(catalog.runs[0].messageCommandId).toBe("message");
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
it("reads and supplements an older task beyond the catalog window without exposing another conversation", async () => {
  const f = await fixture();
  await f.call(`${f.base}/execution/authorize`, f.authorization);
  await f.call("/api/scenarios/workers", { id: "worker", roles: ["researcher"], capabilities: Object.values(WEB_BLACKBOX_CAPABILITIES), maxConcurrentWork: 1 });
  const ids: string[] = [];
  for (let index = 0; index < 21; index++) {
    const messageCommandId = `request-${index}`;
    await f.call(`${f.base}/messages`, { commandId: messageCommandId, text: "Review a neutral local observation" });
    const started = await f.call(`${f.base}/execution`, { ...f.command, commandId: `dispatch-${index}`, messageCommandId });
    expect([200, 201]).toContain(started.statusCode);
    ids.push(started.json().runId);
  }
  const catalog = (await f.call(`${f.base}/execution`)).json();
  expect(catalog.truncated).toBe(true); expect(catalog.runs).toHaveLength(20);
  const runId = ids.find(value => !catalog.runs.some((run: any) => run.runId === value))!;
  expect(runId).toBeTruthy();
  const state = (await f.call(`/api/scenarios/runs/${runId}`)).json();
  const proposed = await f.call(`/api/scenarios/runs/${runId}/work`, { commandId: "older-work", expectedRevision: state.revision,
    proposal: { id: "work", kind: "research", title: "Neutral review", objective: "Review existing observations", idempotencyKey: "older-effect" } });
  expect(proposed.statusCode, proposed.body).toBe(200);
  await f.call(`${f.base}/messages`, { commandId: "supplement", text: "Keep this additional observation unverified." });
  const request = async (path: string, body?: Record<string, unknown>) => {
    const result = await f.call(path, body); return { status: result.statusCode, body: result.json() };
  };
  const execute = (name: string, input: unknown) => createConversationTaskPort(f.sql, request).execute(
    f.conversation.id, "supplement", { id: "call", name, input }, new AbortController().signal);
  const read = await execute("task_read", { runId }) as any;
  expect(JSON.parse(read.content).runId).toBe(runId);
  expect(await execute("task_input", { runId, workId: "work" })).toMatchObject({ state: "input_saved", resumed: false });
  // A fresh adapter must return the saved receipt, not apply the instruction twice.
  expect(await execute("task_input", { runId, workId: "work" })).toMatchObject({ state: "input_saved" });
  const after = JSON.parse((await execute("task_read", { runId }) as any).content);
  expect(after.directives.filter((item: any) => item.instruction === "Keep this additional observation unverified.")).toHaveLength(1);
  const other = (await f.call("/api/desktop/conversations", { commandId: "foreign", title: "Other" })).json();
  expect((await f.call(`/api/desktop/conversations/${other.id}/execution?runId=${runId}`)).statusCode).toBe(404);
  expect((await f.call(`${f.base}/execution?runId=missing`)).statusCode).toBe(404);
  expect((await f.call(`${f.base}/execution?runId=../invalid`)).statusCode).toBe(400);
});
async function fixture(continueWork?: DesktopExecutionPort["continueWork"]) {
  const app = Fastify(), db = createDb(":memory:"), sql = getSqliteClient(db);
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(),"traceforge-conversation-workspace-")));
  const workspaces = new ConversationWorkspaces(sql,projectRoot);
  const control = new FoundationHostControl(app, sql), channel = control.management();
  const pkg = webBlackboxControlPlanePackage();
  registerScenarioRoutes(app, sql, { definitions: new ScenarioDefinitionRegistry([pkg.definition]), packages: new ScenarioPackageRegistry([pkg]) });
  registerConversationRoutes(app, db, workspaces);
  const events = new SqliteScenarioAgentEventStream(sql);
  registerScenarioAgentEventRoutes(app, events);
  let ready = true, loseResponse = false, corruptReply = false, rejectCommitted = false;
  registerDesktopExecutionRoutes(app, sql, { continueWork, ready: () => ready, request: async (url, body) => {
    const response = await app.inject({ url, method: body ? "POST" : "GET", headers: channel.headers(), ...(body ? { payload: body } : {}) });
    if (loseResponse && url === "/api/scenarios/runs" && body) { loseResponse = false; throw new Error("response lost"); }
    if (corruptReply && url === "/api/scenarios/runs" && body) { corruptReply = false; return { status: 200, body: {} }; }
    if (rejectCommitted && url === "/api/scenarios/runs" && body) { rejectCommitted = false; return { status: 409, body: { error: "uncertain upstream response" } }; }
    return { status: response.statusCode, body: response.json() };
  } }, workspaces);
  await app.ready(); cleanups.push(async () => { await app.close(); sql.close(); rmSync(projectRoot,{recursive:true,force:true}); });
  const call = (url: string, payload?: object) => app.inject({ url, method: payload ? "POST" : "GET", headers: channel.headers(), ...(payload ? { payload } : {}) });
  const conversation = (await call("/api/desktop/conversations", { commandId: "create", title: "Neutral assessment" })).json();
  const base = `/api/desktop/conversations/${conversation.id}`;
  await call(`${base}/messages`, { commandId: "message", text: "Inspect the explicitly authorized scope" });
  const authorization = { commandId: "scope", scenarioKind: pkg.definition.kind, definitionVersion: pkg.definition.version,
    scope: { targets: ["https://authorized.example"], authorizedActions: ["scope.read", "evidence.write", "web.request.replay", "report.write"] },
    expiresAt: "2099-01-01T00:00:00.000Z", confirmed: true };
  const command = { commandId: "dispatch", messageCommandId: "message", scopeRef: "scope", scenarioKind: pkg.definition.kind, definitionVersion: pkg.definition.version };
  return { app, call, base, authorization, command, sql, events, workspaces, conversation, setReady(value: boolean) { ready = value; }, lose() { loseResponse = true; },
    corrupt() { corruptReply = true; }, rejectCommitted() { rejectCommitted = true; } };
}
it("requires explicit desktop continuation and checks conversation ownership before the operator port", async () => {
  const port=vi.fn(async (input:any)=>({audit:{...input,operation:"continue" as const,outcome:"queued" as const,authorizationRef:"local",failure:null,at:new Date().toISOString()},replayed:false}));
  const f=await fixture(port);
  await f.call(`${f.base}/execution/authorize`,f.authorization);
  const runId=(await f.call(`${f.base}/execution`,f.command)).json().runId;
  const body={commandId:"continue-desktop",runId,workId:"work",expectedRevision:1,checkpointRef:`checkpoint://sha256-${"a".repeat(64)}.json`,reason:"Connection restored"};
  expect((await f.call(`${f.base}/execution/continue`,body)).statusCode).toBe(400);expect(port).not.toHaveBeenCalled();
  const other=(await f.call("/api/desktop/conversations",{commandId:"other",title:"Other"})).json();
  expect((await f.call(`/api/desktop/conversations/${other.id}/execution/continue`,{...body,confirmed:true})).statusCode).toBe(404);expect(port).not.toHaveBeenCalled();
  expect((await f.call(`${f.base}/execution/continue`,{...body,confirmed:true})).json().desktopReceipt).toMatchObject({operation:"continue",resourceId:"work"});
  expect(port).toHaveBeenCalledWith({...body,actor:"desktop-operator"});
});
async function waitingFixture() {
  const f = await fixture();
  await f.call(`${f.base}/execution/authorize`, f.authorization);
  await f.call("/api/scenarios/workers", { id: "worker", roles: ["researcher"], capabilities: Object.values(WEB_BLACKBOX_CAPABILITIES), maxConcurrentWork: 1 });
  const runId = (await f.call(`${f.base}/execution`, f.command)).json().runId;
  const state = async () => (await f.call(`/api/scenarios/runs/${runId}`)).json();
  const proposed = await f.call(`/api/scenarios/runs/${runId}/work`, { commandId: "propose", expectedRevision: (await state()).revision,
    proposal: { id: "work", kind: "research", title: "Collect observations", objective: "Collect authorized observations", idempotencyKey: "effect" } });
  expect(proposed.statusCode).toBe(200);
  // Tick has no required payload but needs POST.
  const tick = await f.call(`/api/scenarios/runs/${runId}/tick`, {});
  const lease = tick.json().assignments[0]; expect(lease).toBeDefined();
  const inputRef = await new SqliteWorkerCheckpointStore(f.sql).save({ version: 2, caseId: (await state()).caseId, runId, workId: "work", workKey: "effect", workerId: "worker", leaseId: lease.leaseId,
    savedAt: new Date().toISOString(), turn: 0, transcript: [], steering: [], completedInvocationIds: [], consecutiveFailures: 0,
    pendingInvocation: { turn: 1, invocation: { id: "action", tool: "bounded.tool", rationale: "Explicit decision needed", input: { resource: "neutral-resource", mode: "bounded" } }, risk: "privileged", contractFingerprint: "a".repeat(64) } });
  expect((await f.call(`/api/scenarios/runs/${runId}/work/work/checkpoint`, { commandId: "checkpoint", expectedRevision: (await state()).revision,
    workerId: "worker", leaseId: lease.leaseId, checkpointId: "checkpoint", progressSummary: "Awaiting decision", payloadRef: inputRef })).statusCode).toBe(200);
  const requested = await f.call(`/api/scenarios/runs/${runId}/work/work/request-approval`, { commandId: "ask", expectedRevision: (await state()).revision,
    workerId: "worker", leaseId: lease.leaseId, approvalId: "approval", actionKey: "effect:action", toolName: "bounded.tool", risk: "privileged", rationale: "Explicit decision needed", inputRef });
  expect(requested.statusCode, requested.body).toBe(200);
  return { ...f, runId, state, inputRef };
}
it("pauses and explicitly resumes through the desktop bridge without granting scope",async()=>{
  const f=await waitingFixture(),before=await f.state();
  const pause={commandId:"pause-desktop",runId:f.runId,expectedRevision:before.revision};
  const paused=await f.call(`${f.base}/execution/pause`,pause);
  expect(paused.statusCode,paused.body).toBe(200);expect(paused.json().desktopReceipt.operation).toBe("pause");
  expect((await f.call(`${f.base}/execution/pause`,pause)).statusCode).toBe(200);
  const state=await f.state();expect(state.status).toBe("paused");expect(state.scopeRef).toBe(before.scopeRef);
  const resume={commandId:"resume-desktop",runId:f.runId,expectedRevision:state.revision};
  expect((await f.call(`${f.base}/execution/resume`,resume)).statusCode).toBe(400);
  const restored=await f.call(`${f.base}/execution/resume`,{...resume,confirmed:true});
  expect(restored.statusCode,restored.body).toBe(200);expect(restored.json().desktopReceipt.operation).toBe("resume");
  expect((await f.state()).status).toBe("running");expect((await f.state()).scopeRef).toBe(before.scopeRef);
});
it("replays approved and rejected operator decisions after response loss without granting twice", async () => {
  for (const approved of [true, false]) {
    const f = await waitingFixture();
    const body = { commandId: "decision", runId: f.runId, workId: "work", expectedRevision: (await f.state()).revision, approvalId: "approval", approved, reason: "Reviewed the exact action", reviewedInputRef: f.inputRef };
    let lose = true;
    const transport = { protocolVersion: 1 as const, request: async (input: { path: string; body?: string }) => {
      const result = await f.call(input.path, JSON.parse(input.body!));
      if (lose) { lose = false; throw new Error("lost after commit"); }
      return { status: result.statusCode, body: result.json() };
    } };
    const values = new Map<string,string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string,value: string) => { values.set(key,value); }, removeItem: (key: string) => { values.delete(key); } };
    const controller = new ExecutionController(transport, storage, f.base.split("/").at(-1)!);
    await expect(controller.execute({ path: `${f.base}/execution/approval`, body })).rejects.toThrow("结果未知");
    const before = await f.state();
    expect((await controller.execute()).operation).toBe("approval");
    expect((await f.state()).revision).toBe(before.revision);
    expect(before.workItems[0].approvalHistory[0].status).toBe(approved ? "approved" : "rejected");
    expect((await f.call(`${f.base}/execution/approval`, { ...body, approved: !approved })).statusCode).toBe(409);
  }
});
it("persists operator context, carries it to worker assignments, and never changes scope or approval", async () => {
  const f = await waitingFixture(), before = await f.state();
  const body = { commandId: "input", runId: f.runId, workId: "work", expectedRevision: before.revision, instruction: "Use the additional observation as unverified context." };
  const saved = await f.call(`${f.base}/execution/input`, body);
  expect(saved.statusCode).toBe(200); expect(saved.json().desktopReceipt.operation).toBe("input");
  const after = await f.state();
  expect(after.directives).toContainEqual(expect.objectContaining({ id: "input", issuedBy: "operator", instruction: body.instruction }));
  expect(after.scopeRef).toBe(before.scopeRef); expect(after.workItems[0].status).toBe("waiting_approval");
  expect((await f.call(`${f.base}/execution/input`, body)).statusCode).toBe(200);
  expect((await f.state()).revision).toBe(after.revision);
  expect((await f.call(`${f.base}/execution/input`, { ...body, instruction: "changed" })).statusCode).toBe(409);
  await f.call(`${f.base}/execution/approval`, { commandId: "approve", runId: f.runId, workId: "work", expectedRevision: after.revision, approvalId: "approval", approved: true, reason: "Approved", reviewedInputRef: f.inputRef });
  await f.call(`/api/scenarios/runs/${f.runId}/tick`, {});
  const assignments = (await f.call("/api/scenarios/workers/worker/assignments")).json();
  expect(assignments[0].runContext.directives[0]).toMatchObject({ issuedBy: "operator", instruction: body.instruction });
});
it("rejects cross-conversation, stale revision and revoked-scope operator commands", async () => {
  const f = await waitingFixture(), current = await f.state();
  const body = { commandId: "input", runId: f.runId, workId: "work", expectedRevision: current.revision, instruction: "Additional context" };
  const other = (await f.call("/api/desktop/conversations", { commandId: "other", title: "Other" })).json();
  expect((await f.call(`/api/desktop/conversations/${other.id}/execution/input`, body)).statusCode).toBe(404);
  expect((await f.call(`${f.base}/execution/input`, { ...body, expectedRevision: 0 })).statusCode).toBe(409);
  await f.call("/api/scenarios/authorizations/scope/revoke", {});
  expect((await f.call(`${f.base}/execution/input`, body)).statusCode).not.toBe(200);
  expect((await f.state()).directives).toHaveLength(0);
});
it("records context during pause or blocked work without resuming or retrying", async () => {
  const f = await waitingFixture();
  await f.call(`/api/scenarios/runs/${f.runId}/pause`, { commandId: "pause", expectedRevision: (await f.state()).revision, reason: "Operator pause" });
  const input = { commandId: "paused-input", runId: f.runId, workId: "work", expectedRevision: (await f.state()).revision, instruction: "Context for later review" };
  expect((await f.call(`${f.base}/execution/input`, input)).statusCode).toBe(200);
  expect((await f.state()).status).toBe("paused");
  await f.call(`/api/scenarios/runs/${f.runId}/resume`, { commandId: "resume", expectedRevision: (await f.state()).revision, reason: "Resume explicitly" });
  await f.call(`${f.base}/execution/approval`, { commandId: "reject", runId: f.runId, workId: "work", approvalId: "approval", expectedRevision: (await f.state()).revision, approved: false, reason: "Do not execute" });
  const before = await f.state(); expect(before.workItems[0].status).toBe("blocked");
  expect((await f.call(`${f.base}/execution/input`, { ...input, commandId: "blocked-input", expectedRevision: before.revision })).statusCode).toBe(200);
  const after = await f.state(); expect(after.workItems[0].status).toBe("blocked"); expect(after.workItems[0].attempt).toBe(before.workItems[0].attempt);
  expect(after.workItems[0].grantedActionKeys).toEqual([]);
});
it("previews only owned exact pending parameters and refuses missing, mismatched or corrupt input", async () => {
  const f = await waitingFixture();
  const read = { runId: f.runId, workId: "work", approvalId: "approval" };
  const result = await f.call(`${f.base}/execution/approval-input`, read);
  expect(result.statusCode).toBe(200); expect(JSON.parse(result.json().input)).toEqual({ resource: "neutral-resource", mode: "bounded" });
  expect(result.json()).not.toHaveProperty("journal");
  const body = { commandId: "decision", ...read, expectedRevision: (await f.state()).revision, approved: true, reason: "Reviewed" };
  expect((await f.call(`${f.base}/execution/approval`, body)).statusCode).toBe(400);
  expect((await f.call(`${f.base}/execution/approval`, { ...body, reviewedInputRef: "other" })).statusCode).toBe(409);
  const other = (await f.call("/api/desktop/conversations", { commandId: "other", title: "Other" })).json();
  expect((await f.call(`/api/desktop/conversations/${other.id}/execution/approval-input`, read)).statusCode).toBe(404);
  const unavailable = vi.spyOn(SqliteWorkerCheckpointStore.prototype, "load").mockRejectedValue(new Error("Unavailable or corrupt checkpoint"));
  try {
    expect((await f.call(`${f.base}/execution/approval-input`, read)).statusCode).toBe(409);
    expect((await f.call(`${f.base}/execution/approval`, { ...body, reviewedInputRef: f.inputRef })).statusCode).toBe(409);
  } finally { unavailable.mockRestore(); }
  expect((await f.state()).workItems[0].status).toBe("waiting_approval");
});
it("starts a real Run through the existing Scenario API and cancels using its revision", async () => {
  const f = await fixture();
  expect((await f.call(`${f.base}/execution/authorize`, f.authorization)).statusCode).toBe(201);
  expect((await f.call(`${f.base}/execution/authorize`, f.authorization)).statusCode).toBe(200);
  const started = await f.call(`${f.base}/execution`, f.command);
  expect(started.statusCode).toBe(201);
  expect(started.json().desktopReceipt).toMatchObject({ version: 1, commandId: f.command.commandId, operation: "dispatch", resourceId: started.json().runId });
  const catalog = (await f.call(`${f.base}/execution`)).json();
  expect(catalog.runs).toHaveLength(1); expect(catalog.runs[0].goal).toBe("Inspect the explicitly authorized scope");
  expect(catalog.runs[0].messageCommandId).toBe("message");
  const run = catalog.runs[0];
  const cancelled = await f.call(`${f.base}/execution/cancel`, { commandId: "cancel", runId: run.runId, expectedRevision: run.revision });
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json().desktopReceipt).toMatchObject({ operation: "cancel", commandId: "cancel", resourceId: run.runId });
  expect((await f.call(`${f.base}/execution`)).json().runs[0].status).toBe("cancelled");
});
it("reads durable progress only for a conversation-owned run and validates pagination", async () => {
  const f = await fixture();
  await f.call(`${f.base}/execution/authorize`, f.authorization);
  const started = (await f.call(`${f.base}/execution`, f.command)).json();
  const state = (await f.call(`/api/scenarios/runs/${started.runId}`)).json();
  f.events.append({ runId: state.id, caseId: state.caseId, workId: null, turnId: "turn", role: "system", method: "turn/started",
    params: { agentInstanceId: "agent", sourceRunRevision: state.revision, sourceGraphRevision: null } });
  const path = `${f.base}/execution/${state.id}/events`;
  const page = await f.call(`${path}?after=0`);
  expect(page.statusCode).toBe(200); expect(page.json().events).toHaveLength(1);
  expect((await f.call(`${path}?after=1`)).json().events).toHaveLength(0);
  expect((await f.call(`${path}?after=-1`)).statusCode).toBe(400);
  const other = (await f.call("/api/desktop/conversations", { commandId: "other", title: "Other" })).json();
  expect((await f.call(`/api/desktop/conversations/${other.id}/execution/${state.id}/events?after=0`)).statusCode).toBe(404);
});
it("projects the installed form and registers its literal scope before explicit dispatch", async () => {
  const f = await fixture();
  const catalog = (await f.call(`${f.base}/execution`)).json(), definition = catalog.definitions[0];
  const form = AuthorizationFormSchema.parse(definition.authorizationForm);
const scope = buildAuthorizationScope(form, form.fields.map(field => field.type === "integer" ? String(field.defaultValue ?? "") : field.path[0] === "targets" ? "https://first.example/exact" : ""));
  scope.authorizedActions = ["scope.read", "evidence.write"];
  expect(definition.authorizationReview.allowedActions).toContain("scope.read");
  expect((await f.call(`${f.base}/execution/authorize`, { ...f.authorization, scope })).statusCode).toBe(201);
  const registered = (await f.call(`${f.base}/execution`)).json();
  expect(registered.scopes[0].scope).toEqual(scope); expect(registered.runs).toHaveLength(0);
  expect((await f.call(`${f.base}/execution`, f.command)).statusCode).toBe(201);
});
it("keeps malformed success uncertain and reconciles rejection after an actual commit", async () => {
  for (const mode of ["corrupt", "rejectCommitted"] as const) {
    const f = await fixture(); await f.call(`${f.base}/execution/authorize`, f.authorization); f[mode]();
    const first = await f.call(`${f.base}/execution`, f.command);
    expect(first.statusCode).toBe(mode === "corrupt" ? 503 : 200);
    if (mode === "corrupt") expect(first.json().desktopReceipt).toBeUndefined();
    const recovered = await f.call(`${f.base}/execution`, f.command);
    expect(recovered.json().desktopReceipt).toMatchObject({ operation: "dispatch", commandId: f.command.commandId });
    expect((await f.call(`${f.base}/execution`)).json().runs).toHaveLength(1);
  }
});
it("completes authorization, response-loss recovery and cancellation through the desktop command controller", async () => {
  const f = await fixture(), conversationId = f.base.split("/").at(-1)!;
  const bridge = createConversationBridge({ webContentsId: 7, origin: "http://127.0.0.1:12345", host: { request: async request => {
    const response = await f.call(request.path, JSON.parse(request.body!)); return { status: response.statusCode, body: response.json() };
  } } });
  const transport = { protocolVersion: 1 as const, request: (request: { path: string; method: "GET" | "POST"; body?: string }) =>
    bridge.request({ webContentsId: 7, mainFrame: true, url: "http://127.0.0.1:12345/" }, request) };
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const controller = new ExecutionController(transport, storage, conversationId);
  expect((await controller.execute({ path: `${f.base}/execution/authorize`, body: f.authorization })).operation).toBe("authorize");
  f.lose(); await expect(controller.execute({ path: `${f.base}/execution`, body: f.command })).rejects.toThrow("结果未知");
  expect(controller.pending?.body.commandId).toBe(f.command.commandId);
  const reopened = new ExecutionController(transport, storage, conversationId);
  const accepted = await reopened.execute(); expect(accepted.operation).toBe("dispatch"); expect(reopened.pending).toBeNull();
  const run = (await f.call(`${f.base}/execution`)).json().runs[0];
  const cancelled = await reopened.execute({ path: `${f.base}/execution/cancel`, body: { commandId: "cancel", runId: run.runId, expectedRevision: run.revision } });
  expect(cancelled.resourceId).toBe(accepted.resourceId); expect(cancelled.operation).toBe("cancel"); expect(reopened.pending).toBeNull();
});
it("reconciles a committed Run after response loss without creating another Run", async () => {
  const f = await fixture(); await f.call(`${f.base}/execution/authorize`, f.authorization); f.lose();
  expect((await f.call(`${f.base}/execution`, f.command)).statusCode).toBe(500);
  expect((await f.call(`${f.base}/execution`, f.command)).statusCode).toBe(200);
  expect((await f.call(`${f.base}/execution`, f.command)).json().desktopReceipt).toMatchObject({ operation: "dispatch", commandId: f.command.commandId });
  expect((await f.call(`${f.base}/execution`)).json().runs).toHaveLength(1);
  expect((await f.call(`${f.base}/execution`)).json().runs[0].messageCommandId).toBe("message");
  expect((await f.call(`${f.base}/execution`, { ...f.command, scopeRef: "changed" })).statusCode).toBe(409);
});
it("leaves historical runs unbound rather than guessing from identical goal text", async () => {
  const f = await fixture(); await f.call(`${f.base}/execution/authorize`, f.authorization);
  await f.call(`${f.base}/execution`, f.command);
  // Legacy/imported runs can exist without a desktop command binding.
  f.sql.prepare("DELETE FROM desktop_execution_commands").run();
  const runs = (await f.call(`${f.base}/execution`)).json().runs;
  expect(runs).toHaveLength(1);
  expect(runs[0].messageCommandId).toBeNull();
});
it("requires a model and existing valid scope, and permits correcting a rejected dispatch", async () => {
  const f = await fixture(); f.setReady(false);
  expect((await f.call(`${f.base}/execution`, f.command)).statusCode).toBe(409);
  f.setReady(true); expect((await f.call(`${f.base}/execution`, f.command)).statusCode).toBe(403);
  await f.call(`${f.base}/execution/authorize`, f.authorization);
  expect((await f.call(`${f.base}/execution`, { ...f.command, commandId: "corrected" })).statusCode).toBe(201);
});
it("rejects unauthenticated requests and cross-conversation cancellation", async () => {
  const f = await fixture(); expect((await f.app.inject({ url: `${f.base}/execution` })).statusCode).toBe(401);
  await f.call(`${f.base}/execution/authorize`, f.authorization);
  const runId = (await f.call(`${f.base}/execution`, f.command)).json().runId;
  const other = (await f.call("/api/desktop/conversations", { commandId: "other", title: "Other case" })).json();
  expect((await f.call(`/api/desktop/conversations/${other.id}/execution/cancel`, { commandId: "bad", runId, expectedRevision: 1 })).statusCode).toBe(404);
  expect((await f.call(`${f.base}/execution/authorize`, { ...f.authorization, scope: {} })).statusCode).toBe(409);
});
