import { z } from "zod";

export const ReplyIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const ReplyStateSchema = z.enum(["streaming", "completed", "cancelled", "interrupted", "failed"]);
export const DesktopReplySchema = z.object({
  conversationId: ReplyIdSchema,
  messageCommandId: ReplyIdSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: ReplyStateSchema,
  text: z.string().max(65536),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  contextMessages: z.number().int().min(1).max(200),
  contextTruncated: z.boolean(),
  error: z.enum(["provider_failed", "output_limit", "invalid_completion", "host_stopped", "timeout"]).nullable(),
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
