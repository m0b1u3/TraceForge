import { z } from "zod";
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const ReplyQueueCommandSchema=z.object({
  commandId:id, expectedRevision:z.number().int().nonnegative(),
  operation:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("pause"),paused:z.boolean()}).strict(),
    z.object({kind:z.literal("edit"),messageId:id,text:z.string().trim().min(1).max(16000)}).strict(),
    z.object({kind:z.literal("reorder"),ids:z.array(id).max(64)}).strict(),
    z.object({kind:z.literal("remove"),messageId:id}).strict(),
  ]),
}).strict();
export const ReplyQueueViewSchema=z.object({conversationId:id,revision:z.number().int().nonnegative(),paused:z.boolean(),
  items:z.array(z.object({messageId:id,text:z.string().max(16000)}).strict()).max(64)}).strict();
export type ReplyQueueCommand=z.infer<typeof ReplyQueueCommandSchema>;
