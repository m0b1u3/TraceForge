import { z } from "zod";

export const MessageAttachmentSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("reference"),id:z.string().uuid(),name:z.string().min(1).max(200)}).strict(),
  z.object({kind:z.literal("document"),name:z.string().min(1).max(200),mediaType:z.literal("application/pdf"),data:z.string().min(4).max(1400000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict(),
  z.object({kind:z.literal("audio"),name:z.string().min(1).max(200),mediaType:z.enum(["audio/wav","audio/mpeg"]),data:z.string().min(4).max(1400000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict(),
  z.object({kind:z.literal("image"),name:z.string().min(1).max(200),mediaType:z.enum(["image/png","image/jpeg"]),data:z.string().min(4).max(1400000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict(),
  z.object({kind:z.literal("text"),name:z.string().min(1).max(200),text:z.string().max(64000)}).strict(),
]);
export const MessageAttachmentsSchema=z.array(MessageAttachmentSchema).max(4).refine(items=>items.every(item=>item.kind==="text" || item.kind==="reference" || item.data.length/4*3-(item.data.endsWith("==")?2:item.data.endsWith("=")?1:0)<=1048576) && new TextEncoder().encode(JSON.stringify(items)).byteLength<=2800000,"附件总量超过限制");
export type MessageAttachment=z.infer<typeof MessageAttachmentSchema>;
export const AttachmentPreviewRequestSchema=z.object({messageId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),index:z.number().int().min(0).max(3),page:z.number().int().min(1).max(10000).optional(),offset:z.number().int().min(0).max(33554432).optional(),expectedDigest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const AttachmentPreviewSchema=z.object({conversationId:z.string(),messageId:z.string(),index:z.number().int(),digest:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().max(200),
  kind:z.enum(["text","image","pdf"]),mediaType:z.enum(["image/png","image/jpeg","application/pdf"]).optional(),data:z.string().min(4).max(1400000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),text:z.string().max(16000).optional(),page:z.number().int().positive().optional(),pages:z.number().int().positive().optional(),nextOffset:z.number().int().nonnegative().nullable().optional()}).strict().refine(value=>value.kind==="text"?value.text!==undefined:value.kind==="image"?!!value.data&&["image/png","image/jpeg"].includes(value.mediaType??""):!!value.data&&value.mediaType==="application/pdf"&&!!value.page&&!!value.pages&&value.page<=value.pages,"Invalid preview content");
export class AttachmentInputError extends Error { constructor(){super("附件类型未接通、能力未确认或内容无效；请核对模型能力和文件格式。");} }
