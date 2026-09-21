import { z } from "zod";
const id = z.string().min(1).max(256);
export const BrowserViewSchema = z.object({ generation: z.number().int().positive(), pageId: id, documentId: id }).strict();
const element = z.object({ view: BrowserViewSchema, backendNodeId: z.number().int().positive() }).strict();
const manualInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().min(0).lt(1), y: z.number().min(0).lt(1) }).strict(),
  z.object({ type: z.literal("scroll"), x: z.number().min(0).lt(1), y: z.number().min(0).lt(1), deltaY: z.number().min(-2000).max(2000) }).strict(),
  z.object({ type: z.literal("text"), text: z.string().max(8192) }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]) }).strict(),
]);
export const BrowserActionSchema = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("navigate"), view: BrowserViewSchema, url: z.string().url().max(8192) }).strict(),
  z.object({ id, kind: z.literal("click"), element }).strict(),
  z.object({ id, kind: z.literal("fill"), element, text: z.string().max(8192) }).strict(),
  z.object({ id, kind: z.literal("press"), element, key: z.enum(["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]) }).strict(),
]);
export const DesktopBrowserCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("preview"), sessionId: id, commandId: id, takeoverId: id, pageId: id.optional() }).strict(),
  z.object({ operation: z.literal("input"), sessionId: id, commandId: id, takeoverId: id, frameId: id, input: manualInput }).strict(),
  z.object({ operation: z.literal("takeover"), sessionId: id, commandId: id }).strict(),
  z.object({ operation: z.literal("resume"), sessionId: id, commandId: id, takeoverId: id }).strict(),
  z.object({ operation: z.literal("close"), sessionId: id, commandId: id }).strict(),
  z.object({ operation: z.literal("observe"), sessionId: id, commandId: id, takeoverId: id, pageId: id.optional() }).strict(),
  z.object({ operation: z.literal("act"), sessionId: id, commandId: id, takeoverId: id, action: BrowserActionSchema }).strict(),
]);
export type DesktopBrowserCommand = z.infer<typeof DesktopBrowserCommandSchema>;
export const DesktopBrowserFrameSchema = z.object({ frameId: id, view: BrowserViewSchema,
  bodyBase64: z.string().max(5592408).regex(/^[A-Za-z0-9+/]+={0,2}$/), width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048) }).strict();
export const DesktopBrowserListSchema = z.object({ sessions: z.array(z.object({ id, status: z.enum(["active", "manual_control", "frozen", "closed", "closing", "cleanup_unknown"]),
  isolation: z.literal("chromium").optional(),
  takeoverId: id.nullable(), expiresAt: z.string(), workId: id }).strict()).max(16) }).strict();
export const DesktopBrowserDocumentSchema = z.object({ document: z.object({ nodes: z.array(z.object({
  role: z.string(), name: z.string(), description: z.string(), disabled: z.boolean(), editable: z.boolean(), element: element.optional(),
}).passthrough()).max(5000) }).passthrough() }).passthrough();
