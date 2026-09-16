import { z } from "zod";

const binding = z.object({ id: z.string().min(1).max(256), version: z.string().min(1).max(128), schemaRevision: z.number().int().positive() }).strict();
export const ResourceOverrideSchema = z.object({
  id: z.string().min(1).max(256), enabled: z.boolean(),
  // null means package default; an empty string is an intentional empty override.
  content: z.string().max(65536).nullable(),
}).strict();
export const UserResourceSchema = z.object({
  id: z.string().regex(/^user\.[a-zA-Z0-9_-]{1,100}$/),
  parentId: z.string().min(1).max(256),
  kind: z.enum(["skill", "knowledge", "prompt"]),
  title: z.string().trim().min(1).max(160),
  content: z.string().max(65536), enabled: z.boolean(),
  roles: z.array(z.enum(["worker", "planner", "observer"])).min(1).max(3),
  phases: z.array(z.string().min(1).max(256)).max(64),
  source: z.object({kind:z.enum(["editor","file"]),name:z.string().min(1).max(200)}).strict().optional(),
}).strict();
export type UserResource = z.infer<typeof UserResourceSchema>;
export const guidanceVariables = ["goal", "phase", "role", "runId", "caseId"] as const;
export function renderGuidanceTemplate(content: string, values: Record<string,string>): string {
  const rendered = content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match,name:string) => {
    if (!(guidanceVariables as readonly string[]).includes(name) || !Object.hasOwn(values,name)) throw new Error(`Unknown guidance variable: ${name}`);
    return values[name]!;
  });
  if (new TextEncoder().encode(rendered).byteLength>65536) throw new Error("Rendered guidance exceeds 64 KiB");
  return rendered;
}
export const ConfigurationSaveSchema = z.object({
  package: binding, expectedRevision: z.number().int().nonnegative(),
  resources: z.array(ResourceOverrideSchema).max(128),
  userResources: z.array(UserResourceSchema).max(64).optional(),
  mcp: z.array(z.object({ source: z.string().min(1).max(256), profileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    enabled: z.boolean(), tools: z.array(z.string().min(1).max(256)).max(128) }).strict()).max(128),
}).strict();
export type ConfigurationSave = z.infer<typeof ConfigurationSaveSchema>;
export const ConfigurationImportSchema = z.object({ package: binding, expectedRevision:z.number().int().nonnegative(), from:binding }).strict();
export interface ConfigurationImportPreview { draft:ConfigurationSave; conflicts:string[]; }
export interface ConfigurationSnapshot {
  packages: Array<{
    package: ConfigurationSave["package"]; title: string; revision: number;
    userResources?: UserResource[];
    inspection?: { history:Array<{revision:number;changes:string[]}>; runs:Array<{runId:string;revision:number}>; runCount:number };
    previousVersions?: Array<{ package:ConfigurationSave["package"]; revision:number }>;
    resources: Array<{ id: string; type: string; summary: string; phases: string[]; roles: string[];
      enabled: boolean; content: string | null; defaultContent: string; defaultDigest: string; editable: boolean; reason?: string }>;
    mcp: Array<{ source: string; name: string; profileDigest: string; enabled: boolean;
      tools: Array<{ name: string; enabled: boolean }> }>;
  }>;
}
