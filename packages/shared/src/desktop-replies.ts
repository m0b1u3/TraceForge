import { z } from "zod";

export const ReplyIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const DesktopMemoryViewSchema = z.object({ conversationId: ReplyIdSchema, messageId: ReplyIdSchema,
  entries: z.array(z.object({ id: ReplyIdSchema, summary: z.string().max(8192), user: z.string().max(16000), assistant: z.string().max(65536).nullable() }).strict()).max(16),
}).strict();
export const ReplyStateSchema = z.enum(["queued", "streaming", "completed", "cancelled", "interrupted", "failed"]);
export const DesktopReplySchema = z.object({
  conversationId: ReplyIdSchema,
  messageCommandId: ReplyIdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: ReplyStateSchema,
  text: z.string().max(65536),
  taskRequest: z.object({ scenarioKind: z.string().min(1).max(100), definitionVersion: z.number().int().positive() }).strict().optional(),
  reasoning: z.string().max(16000).optional(),
  reasoningTruncated: z.boolean().optional(),
  toolActivity: z.array(z.object({ ordinal: z.number().int().positive(), tool: z.string().max(100), input: z.string().max(2000), output: z.string().max(2000) }).strict()).max(6).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  contextMessages: z.number().int().min(1).max(20000),
  contextTruncated: z.boolean(),
  phase: z.enum(["compacting", "generating", "recalling", "recovering"]).optional(),
  recoveryAttempts: z.number().int().min(0).max(1).optional(),
  recallCount: z.number().int().min(0).max(6).optional(),
  error: z.enum(["provider_failed", "output_limit", "invalid_completion", "host_stopped", "timeout", "context_limit", "recall_limit"]).nullable(),
}).strict();
export type DesktopReply = z.infer<typeof DesktopReplySchema>;
export const DesktopReplyPageSchema = z.object({
  conversationId: ReplyIdSchema,
  replies: z.array(DesktopReplySchema).max(100),
  nextAfter: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hasMore: z.boolean(),
}).strict();

/** An empty command deliberately cannot grant tools, change providers or send arbitrary history. */
export const DesktopReplyCommandSchema = z.object({}).strict();
