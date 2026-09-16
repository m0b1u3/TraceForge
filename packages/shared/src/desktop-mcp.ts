import { z } from "zod";
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const text = z.string().trim().min(1).max(256);
const boundedPath = (path: string) => path.startsWith("/") && !path.includes("\0") && path.split("/").filter(Boolean).length > 0 && !path.split("/").some(part => part === "." || part === "..");
export const McpConnectionSchema = z.object({
  id, name: text, transport: z.enum(["streamable-http","stdio"]),
  endpoint: z.string().max(2048),
  executable:z.string().max(4096).optional(),arguments:z.array(z.string().max(4096)).max(64).optional(),workingDirectory:z.string().max(4096).optional(),
  readPaths:z.array(z.string().max(4096)).max(32).optional(),writePaths:z.array(z.string().max(4096)).max(32).optional(),
  package: z.object({ id: text, version: text, schemaRevision: z.number().int().positive() }).strict(),
  authorizationAction: text, capability: text,
}).strict().superRefine((value,ctx)=>{
  if(value.transport==="streamable-http"){try{const u=new URL(value.endpoint);if(!["https:","http:"].includes(u.protocol)||u.username||u.password||u.hash||u.search)throw new Error();}catch{ctx.addIssue({code:"custom",message:"Use an HTTP(S) endpoint without credentials, query or fragment"});}}
  else if(value.endpoint || !value.executable || !boundedPath(value.executable) || !value.workingDirectory || !boundedPath(value.workingDirectory) || [...value.readPaths??[],...value.writePaths??[]].some(p=>!boundedPath(p)))ctx.addIssue({code:"custom",message:"Stdio requires absolute executable, working directory and bounded filesystem paths without dot segments"});
});
export const McpToolReviewSchema = z.object({ name: text, enabled: z.boolean(),
  resources: z.array(z.object({ field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), kind: text }).strict()).max(32),
}).strict();
export const DesktopMcpOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("save"), expectedRevision: z.number().int().nonnegative(), connection: McpConnectionSchema,
    credential: z.string().min(1).max(16384).regex(/^[A-Za-z0-9._~+\/-]+=*$/).optional(), clearCredential: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("test"), id, expectedRevision: z.number().int().positive(), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal("activate"), id, expectedRevision: z.number().int().positive(), catalogDigest: text,
    tools: z.array(McpToolReviewSchema).min(1).max(128), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal("disable"), id, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ operation: z.literal("delete"), id, expectedRevision: z.number().int().positive(), confirmed: z.literal(true) }).strict(),
]);
export type McpConnection = z.infer<typeof McpConnectionSchema>;
export type DesktopMcpOperation = z.infer<typeof DesktopMcpOperationSchema>;
export interface McpCatalog { serverName: string; serverVersion: string; digest: string; tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
export interface DesktopMcpSnapshot {
  secureStorage: boolean;
  connections: Array<{ connection: McpConnection; revision: number; enabled: boolean; credentialConfigured: boolean;
    inspection?: { lastTest:null|{revision:number;at:string;success:boolean;code:string;recovery:string}; history:Array<{revision:number;operation:string;at:string;success:boolean}>; runs:Array<{runId:string;revision:number}>;runCount:number };
    catalog: McpCatalog | null; reviewedTools: z.infer<typeof McpToolReviewSchema>[];
    effective?: { revision: number; connection: McpConnection; tools: z.infer<typeof McpToolReviewSchema>[] } }>;
  packages: Array<{ package: McpConnection["package"]; title: string; actions: string[]; capabilities: string[]; resourceKinds: string[] }>;
}
