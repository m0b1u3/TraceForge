import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DesktopDispatchSchema, DesktopAuthorizeSchema, DesktopCancelSchema, DesktopResumeSchema, DesktopApprovalSchema, DesktopInputSchema, DesktopApprovalReadSchema, type DesktopExecutionReceipt } from "@traceforge/shared/desktop-execution";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";

export interface DesktopExecutionPort {
  ready(): boolean;
  request(path: string, body?: Record<string, unknown>): Promise<{ status: number; body: any }>;
}
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const dispatch = DesktopDispatchSchema;
const receipt = (conversationId: string, commandId: string, operation: DesktopExecutionReceipt["operation"], resourceId: string): DesktopExecutionReceipt =>
  ({ version: 1, conversationId, commandId, operation, resourceId });

/** Application binding only. Existing Scenario APIs own authorization, Run
 * lifecycle, planning and execution. Saved chat never grants permissions. */
export function registerDesktopExecutionRoutes(app: FastifyInstance, db: Database.Database, host: DesktopExecutionPort) {
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_execution_commands (
    conversation_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE, message_command_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY(conversation_id,command_id));
    CREATE UNIQUE INDEX IF NOT EXISTS desktop_execution_active_message ON desktop_execution_commands(conversation_id,message_command_id) WHERE status != 'rejected';
    CREATE TABLE IF NOT EXISTS desktop_authorization_commands(conversation_id TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(conversation_id,command_id));`);
  const owner = (value: string) => db.prepare("SELECT case_id AS caseId FROM desktop_conversations WHERE id=?").get(value) as { caseId: string } | undefined;
  const path = "/api/desktop/conversations/:conversationId/execution";
  const readApprovalInput = async (state: any, workId: string, approvalId: string, includeHistory = false) => {
    const work = state.workItems.find((item: any) => item.id === workId);
    const approval = work?.pendingApproval?.id === approvalId ? work.pendingApproval
      : includeHistory ? work?.approvalHistory.find((item: any) => item.id === approvalId) : undefined;
    if (!approval) throw new Error("Approval unavailable");
    if (work.pendingApproval?.id === approvalId && work.latestCheckpoint?.payloadRef !== approval.inputRef) throw new Error("Checkpoint reference changed");
    const checkpoint = await new SqliteWorkerCheckpointStore(db).load(approval.inputRef);
    const pending = checkpoint.pendingInvocation;
    if (checkpoint.caseId !== state.caseId || checkpoint.runId !== state.id || checkpoint.workId !== workId || checkpoint.workKey !== work.idempotencyKey
      || !pending || pending.invocation.tool !== approval.toolName || pending.risk !== approval.risk
      || `${work.idempotencyKey}:${pending.invocation.id}` !== approval.actionKey) throw new Error("Approval input identity mismatch");
    const input = JSON.stringify(pending.invocation.input, null, 2);
    if (Buffer.byteLength(input) > 32768) throw new Error("Approval input exceeds preview limit");
    return { runId: state.id, workId, approvalId, inputRef: approval.inputRef, input };
  };
  app.post(`${path}/approval-input`, async (request, reply) => {
    const params = id.safeParse((request.params as any).conversationId), body = DesktopApprovalReadSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_approval_preview" });
    const conversation = owner(params.data);
    const state = conversation && await host.request(`/api/scenarios/runs/${body.data.runId}`);
    if (!state || state.status !== 200 || state.body?.id !== body.data.runId || state.body?.caseId !== conversation!.caseId) return reply.code(404).send({ error: "run_not_found" });
    try { return await readApprovalInput(state.body, body.data.workId, body.data.approvalId); }
    catch { return reply.code(409).send({ error: "approval_input_unavailable" }); }
  });
  for (const operation of ["approval", "input"] as const) app.post(`${path}/${operation}`, async (request, reply) => {
    const params = id.safeParse((request.params as any).conversationId);
    const body = (operation === "approval" ? DesktopApprovalSchema : DesktopInputSchema).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_operator_command" });
    const conversation = owner(params.data), value = body.data;
    if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
    const state = await host.request(`/api/scenarios/runs/${value.runId}`);
    if (state.status !== 200 || state.body?.id !== value.runId || state.body?.caseId !== conversation.caseId)
      return reply.code(404).send({ error: "run_not_found" });
    if ("approved" in value && value.approved) {
      try {
        const preview = await readApprovalInput(state.body, value.workId, value.approvalId, true);
        if (value.reviewedInputRef !== preview.inputRef) throw new Error("Input changed");
      } catch {
        const resolved = state.body.workItems.some((work: any) => work.id === value.workId && work.approvalHistory?.some((item: any) => item.id === value.approvalId));
        return reply.code(resolved ? 503 : 409).send({ error: "approval_input_unavailable" });
      }
    }
    const { runId, workId, ...command } = value;
    const { reviewedInputRef: _reviewedInputRef, ...upstream } = command as typeof command & { reviewedInputRef?: string };
    const result = await host.request(`/api/scenarios/runs/${runId}/work/${encodeURIComponent(workId)}/operator-${operation}`, upstream);
    if (result.status >= 200 && result.status < 300) {
      const accepted = result.body?.state;
      const events = result.body?.events;
      const event = Array.isArray(events) && events.find((item: any) => operation === "approval"
        ? item.type === "work_approval_resolved" && item.workId === workId && "approvalId" in value && item.approvalId === value.approvalId && item.approved === value.approved && item.reason === value.reason
        : item.type === "directive_issued" && item.directive?.id === value.commandId && item.directive?.targetWorkId === workId && item.directive?.issuedBy === "operator" && "instruction" in value && item.directive?.instruction === value.instruction);
      if (accepted?.id !== runId || accepted?.caseId !== conversation.caseId || !event)
        return reply.code(503).send({ error: "operator_receipt_unavailable" });
      return { desktopReceipt: receipt(params.data, value.commandId, operation, "approvalId" in value ? value.approvalId : value.commandId) };
    }
    return reply.code(result.status).send({ error: "operator_command_rejected" });
  });
  app.get(`${path}/:runId/events`, async (request, reply) => {
    const params = z.object({ conversationId: id, runId: id }).safeParse(request.params);
    const query = z.object({ after: z.coerce.number().int().min(0).max(999999999999999) }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_progress_read" });
    const conversation = owner(params.data.conversationId);
    if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
    const state = await host.request(`/api/scenarios/runs/${params.data.runId}`);
    if (state.status !== 200 || state.body?.id !== params.data.runId || state.body?.caseId !== conversation.caseId)
      return reply.code(404).send({ error: "run_not_found" });
    const result = await host.request(`/api/scenarios/runs/${params.data.runId}/agent-events?after=${query.data.after}&limit=100`);
    if (result.status !== 200) return reply.code(503).send({ error: "progress_unavailable" });
    return { ...result.body, caseId: conversation.caseId, runId: params.data.runId };
  });
  app.get(path, async (request, reply) => {
    const parsed = id.safeParse((request.params as any).conversationId);
    const conversation = parsed.success ? owner(parsed.data) : undefined;
    if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
    const [definitions, scopes, runs] = await Promise.all([
      host.request("/api/scenarios/definitions"),
      host.request(`/api/scenarios/authorizations?caseId=${encodeURIComponent(conversation.caseId)}`),
      host.request(`/api/scenarios/runs?caseId=${encodeURIComponent(conversation.caseId)}`),
    ]);
    if ([definitions, scopes, runs].some(value => value.status !== 200)) return reply.code(503).send({ error: "execution_catalog_unavailable" });
    const states = await Promise.all(runs.body.slice(0, 20).map((run: { runId: string }) => host.request(`/api/scenarios/runs/${encodeURIComponent(run.runId)}`)));
    if (states.some(value => value.status !== 200)) return reply.code(503).send({ error: "execution_state_unavailable" });
    const binding = db.prepare("SELECT message_command_id AS messageCommandId FROM desktop_execution_commands WHERE conversation_id=? AND run_id=? AND status != 'rejected'");
    return { modelReady: host.ready(), definitions: definitions.body, scopes: scopes.body,
      runs: states.filter(value => value.status === 200).map(value => ({ ...value.body, runId: value.body.id,
        messageCommandId: (binding.get(parsed.data!, value.body.id) as { messageCommandId: string } | undefined)?.messageCommandId ?? null })), truncated: runs.body.length > 20 };
  });
  app.post(path, async (request, reply) => {
    const parsed = dispatch.safeParse(request.body), conversationId = id.safeParse((request.params as any).conversationId);
    if (!parsed.success || !conversationId.success) return reply.code(400).send({ error: "invalid_dispatch" });
    const body = parsed.data, conversation = owner(conversationId.data);
    if (!conversation) return reply.code(404).send({ error: "conversation_not_found" });
    const message = db.prepare("SELECT text FROM desktop_conversation_messages WHERE conversation_id=? AND command_id=?")
      .get(conversationId.data, body.messageCommandId) as { text: string } | undefined;
    if (!message) return reply.code(404).send({ error: "saved_message_required" });
    const fingerprint = JSON.stringify(body);
    const existing = db.prepare("SELECT fingerprint,run_id AS runId,status FROM desktop_execution_commands WHERE conversation_id=? AND command_id=?")
      .get(conversationId.data, body.commandId) as { fingerprint: string; runId: string; status: string } | undefined;
    if (existing && existing.fingerprint !== fingerprint) return reply.code(409).send({ error: "command_conflict" });
    if (existing?.status === "rejected") return reply.code(409).send({ error: "dispatch_rejected_use_new_command" });
    const runId = existing?.runId ?? `run_${createHash("sha256").update(`${conversationId.data}:${body.commandId}`).digest("hex").slice(0, 40)}`;
    if (existing) {
      const priorRun = await host.request(`/api/scenarios/runs/${runId}`);
      if (priorRun.status === 200 && priorRun.body.caseId === conversation.caseId && priorRun.body.id === runId)
        return reply.send({ runId, result: { state: priorRun.body, idempotentReplay: true }, desktopReceipt: receipt(conversationId.data, body.commandId, "dispatch", runId) });
      if (priorRun.status !== 404) return reply.code(503).send({ error: "dispatch_reconciliation_unavailable" });
    }
    if (!host.ready()) return reply.code(409).send({ error: "model_not_ready" });
    // Write-ahead identity makes retry after response loss dispatch the same Run.
    if (!existing) {
      const prior = db.prepare("SELECT run_id FROM desktop_execution_commands WHERE conversation_id=? AND message_command_id=? AND status != 'rejected'")
        .get(conversationId.data, body.messageCommandId);
      if (prior) return reply.code(409).send({ error: "message_already_bound" });
      db.prepare("INSERT INTO desktop_execution_commands(conversation_id,command_id,fingerprint,run_id,message_command_id) VALUES (?,?,?,?,?)")
        .run(conversationId.data, body.commandId, fingerprint, runId, body.messageCommandId);
    }
    const result = await host.request("/api/scenarios/runs", { commandId: body.commandId, runId, caseId: conversation.caseId,
      goal: message.text, scopeRef: body.scopeRef, scenarioKind: body.scenarioKind, definitionVersion: body.definitionVersion });
    if (result.status >= 400 && result.status < 500) {
      const state = await host.request(`/api/scenarios/runs/${runId}`);
      if (state.status === 404) db.prepare("UPDATE desktop_execution_commands SET status='rejected' WHERE conversation_id=? AND command_id=?")
        .run(conversationId.data, body.commandId);
      else if (state.status === 200 && state.body.caseId === conversation.caseId && state.body.id === runId)
        return reply.send({ runId, result: { state: state.body, idempotentReplay: true }, desktopReceipt: receipt(conversationId.data, body.commandId, "dispatch", runId) });
      else return reply.code(503).send({ error: "dispatch_reconciliation_unavailable" });
    }
    if (result.status >= 200 && result.status < 300 && (result.body?.state?.id !== runId || result.body?.state?.caseId !== conversation.caseId))
      return reply.code(503).send({ error: "dispatch_receipt_unavailable" });
    return reply.code(result.status).send({ runId, result: result.body,
      ...(result.status >= 200 && result.status < 300 ? { desktopReceipt: receipt(conversationId.data, body.commandId, "dispatch", runId) } : {}),
      ...(result.status >= 400 ? { error: result.body?.error ?? "dispatch_rejected" } : {}) });
  });
  app.post(`${path}/authorize`, async (request, reply) => {
    const params = id.safeParse((request.params as any).conversationId);
    const body = DesktopAuthorizeSchema.safeParse(request.body);
    const conversation = params.success ? owner(params.data) : undefined;
    if (!conversation || !body.success || Buffer.byteLength(JSON.stringify(body.data.scope)) > 32768) return reply.code(400).send({ error: "invalid_authorization" });
    const value = body.data;
    const fingerprint = JSON.stringify(value);
    const previous = db.prepare("SELECT fingerprint FROM desktop_authorization_commands WHERE conversation_id=? AND command_id=?")
      .get(params.data!, value.commandId) as { fingerprint: string } | undefined;
    if (previous && previous.fingerprint !== fingerprint) return reply.code(409).send({ error: "command_conflict" });
    if (previous) {
      const scopes = await host.request(`/api/scenarios/authorizations?caseId=${encodeURIComponent(conversation.caseId)}`);
      const found = scopes.status === 200 && scopes.body.find((scope: { id: string }) => scope.id === value.commandId);
      if (found && found.caseId === conversation.caseId) return reply.send({ ...found, desktopReceipt: receipt(params.data!, value.commandId, "authorize", found.id) });
    } else db.prepare("INSERT INTO desktop_authorization_commands VALUES (?,?,?)").run(params.data!, value.commandId, fingerprint);
    // Scope semantics remain owned and validated by the selected Scenario.
    const result = await host.request("/api/scenarios/authorizations", { id: value.commandId, caseId: conversation.caseId,
      scenarioKind: value.scenarioKind, definitionVersion: value.definitionVersion, scope: value.scope,
      expiresAt: value.expiresAt, approvedBy: "local-operator" });
    if (result.status >= 200 && result.status < 300) {
      if (result.body?.id !== value.commandId || result.body?.caseId !== conversation.caseId) return reply.code(503).send({ error: "authorization_receipt_unavailable" });
      return reply.code(result.status).send({ ...result.body, desktopReceipt: receipt(params.data!, value.commandId, "authorize", result.body.id) });
    }
    return reply.code(result.status).send(result.body);
  });
  for (const operation of ["cancel","pause","resume"] as const) app.post(`${path}/${operation}`, async (request, reply) => {
    const params = id.safeParse((request.params as any).conversationId);
    const body = (operation==="resume"?DesktopResumeSchema:DesktopCancelSchema).safeParse(request.body);
    const conversation = params.success ? owner(params.data) : undefined;
    if (!conversation || !body.success) return reply.code(400).send({ error: "invalid_lifecycle_command" });
    const state = await host.request(`/api/scenarios/runs/${body.data.runId}`);
    if (state.status !== 200 || state.body?.id !== body.data.runId || state.body.caseId !== conversation.caseId) return reply.code(404).send({ error: "run_not_found" });
    const result = await host.request(`/api/scenarios/runs/${body.data.runId}/${operation}`, {
      commandId: body.data.commandId, expectedRevision: body.data.expectedRevision, reason: `${operation} requested by local operator` });
    if (result.status >= 200 && result.status < 300) {
      if (result.body?.state?.id !== body.data.runId || result.body?.state?.caseId !== conversation.caseId || result.body?.state?.status !== ({cancel:"cancelled",pause:"paused",resume:"running"}[operation]))
        return reply.code(503).send({ error: "lifecycle_receipt_unavailable" });
      return reply.code(result.status).send({ ...result.body, desktopReceipt: receipt(params.data!, body.data.commandId, operation, body.data.runId) });
    }
    return reply.code(result.status).send(result.body);
  });
}
