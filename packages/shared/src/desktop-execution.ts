import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const opaqueId = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
export const DesktopDispatchSchema = z.object({ commandId: id, messageCommandId: id, scopeRef: id,
  scenarioKind: z.string().min(1).max(100), definitionVersion: z.number().int().positive() }).strict();
export const DesktopAuthorizeSchema = z.object({ commandId: id, scenarioKind: z.string().min(1).max(100),
  definitionVersion: z.number().int().positive(), scope: z.record(z.unknown()), expiresAt: z.string().datetime(), confirmed: z.literal(true) }).strict();
export const DesktopCancelSchema = z.object({ commandId: id, runId: id, expectedRevision: z.number().int().nonnegative() }).strict();
export const DesktopResumeSchema = DesktopCancelSchema.extend({confirmed:z.literal(true)}).strict();
export const DesktopPermissionChangeSchema = DesktopCancelSchema.extend({ expectedScopeRevision: z.number().int().positive(), scope: z.record(z.unknown()), reason: z.string().trim().min(1).max(2000), confirmed: z.literal(true),
  resolution: z.object({ workId: opaqueId, requestId: opaqueId, approved: z.boolean() }).strict().optional(),
}).strict();
export const DesktopApprovalSchema = DesktopCancelSchema.extend({ workId: opaqueId, approvalId: opaqueId, approved: z.boolean(), reason: z.string().trim().min(1).max(4000), reviewedInputRef: z.string().min(1).max(4000).optional() }).strict()
  .refine(value => !value.approved || !!value.reviewedInputRef, "Review exact input before approving");
export const DesktopInputSchema = DesktopCancelSchema.extend({ workId: opaqueId, instruction: z.string().trim().min(1).max(8000) }).strict();
export const DesktopApprovalReadSchema = z.object({ runId: id, workId: opaqueId, approvalId: opaqueId }).strict();
export const DesktopPendingApprovalSchema = z.object({ id: opaqueId, workId: opaqueId, actionKey: z.string().min(1).max(4000), toolName: z.string().min(1).max(4000),
  risk: z.enum(["read_only", "bounded_write", "privileged", "destructive"]), rationale: z.string().max(16000), inputRef: z.string().max(4000), status: z.literal("pending") });
export type DesktopPendingApproval = z.infer<typeof DesktopPendingApprovalSchema>;
export const DesktopExecutionReceiptSchema = z.object({ version: z.literal(1), conversationId: id, commandId: id,
  operation: z.enum(["dispatch", "authorize", "cancel", "pause", "resume", "approval", "input"]), resourceId: opaqueId }).strict();
export type DesktopExecutionReceipt = z.infer<typeof DesktopExecutionReceiptSchema>;
export interface DesktopExecutionOperation { path: string; body: Record<string, unknown> }

export function parseDesktopExecutionOperation(value: unknown, conversationId: string): DesktopExecutionOperation {
  id.parse(conversationId);
  const input = z.object({ path: z.string(), body: z.unknown() }).strict().parse(value);
  const base = `/api/desktop/conversations/${conversationId}/execution`;
  const schema = input.path === base ? DesktopDispatchSchema : input.path === `${base}/authorize` ? DesktopAuthorizeSchema
    : input.path === `${base}/cancel` || input.path === `${base}/pause` ? DesktopCancelSchema : input.path === `${base}/resume` ? DesktopResumeSchema : input.path === `${base}/approval` ? DesktopApprovalSchema
    : input.path === `${base}/input` ? DesktopInputSchema : undefined;
  if (!schema) throw new Error("Invalid execution path");
  const body = schema.parse(input.body);
  if (new TextEncoder().encode(JSON.stringify(body)).length > 40000
    || ("scope" in body && new TextEncoder().encode(JSON.stringify(body.scope)).length > 32768)) throw new Error("Execution body exceeds limit");
  return { path: input.path, body };
}
