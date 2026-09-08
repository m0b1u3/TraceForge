import { z } from "zod";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const revision = z.number().int().nonnegative();
const https = z.string().max(4096).refine(value => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.hash && (!u.port || u.port === "443"); } catch { return false; } }, "请输入不含凭证和片段的 HTTPS 地址");
export const ResearchConfigurationSchema = z.object({ provider: z.enum(["disabled", "brave", "searxng"]), endpoint: z.string().max(4096) }).strict().superRefine((value, ctx) => {
  if (value.provider !== "disabled" && (!https.safeParse(value.endpoint).success || new URL(value.endpoint).search)) ctx.addIssue({ code: "custom", message: "搜索端点须为不含查询参数的 HTTPS 地址" });
});
export const DesktopResourceOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("configure"), expectedRevision: revision, configuration: ResearchConfigurationSchema,
    credential: z.string().min(1).max(4096).regex(/^[A-Za-z0-9._~+\/-]+=*$/).optional(), clearCredential: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("search"), kind: z.enum(["web", "github"]), query: z.string().trim().min(1).max(500), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal("fetch"), url: https, confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal("acquire"), commandId: id, repository: z.string().min(1).max(300), ref: z.string().trim().min(1).max(200), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal("prepare"), id, expectedRevision: revision, usage: z.string().trim().min(1).max(16000), entryScript: z.string().trim().min(1).max(16000), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal("enable"), id, expectedRevision: revision, enabled: z.boolean(), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal("read"), id, path: z.string().min(1).max(1024) }).strict(),
]);
export type DesktopResourceOperation = z.infer<typeof DesktopResourceOperationSchema>;
export interface ProjectRecord {
  id: string; revision: number; repository: string; commit: string; digest: string; fileCount: number; bytes: number;
  readme: string; license: string | null; usage: string; entryScript: string; files: string[]; enabled: boolean;
}
export interface DesktopResourceSnapshot {
  revision: number; configuration: z.infer<typeof ResearchConfigurationSchema>; credentialConfigured: boolean; secureStorage: boolean; projects: ProjectRecord[];
}
