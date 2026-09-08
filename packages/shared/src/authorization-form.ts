import { z } from "zod";

const segment = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine(value => !["__proto__", "prototype", "constructor"].includes(value));
/** Data-only presentation. It never grants an action or interprets resource semantics. */
export const AuthorizationFormSchema = z.object({
  version: z.literal(1),
  description: z.string().min(1).max(2000),
  actionLabels: z.record(z.string().min(1).max(256), z.string().min(1).max(120)).optional(),
  fields: z.array(z.object({
    path: z.array(segment).min(1).max(8),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    type: z.literal("string-list"),
    required: z.boolean(),
    advanced: z.boolean().optional(),
    maximumItems: z.number().int().min(1).max(128),
    maximumLength: z.number().int().min(1).max(4096),
  }).strict()).min(1).max(24),
}).strict().superRefine((form, context) => {
  for (let i = 0; i < form.fields.length; i++) for (let j = i + 1; j < form.fields.length; j++) {
    const a = form.fields[i]!.path, b = form.fields[j]!.path;
    if (a.slice(0, Math.min(a.length, b.length)).every((part, index) => part === b[index]))
      context.addIssue({ code: "custom", message: "Overlapping authorization fields" });
  }
});
export type AuthorizationForm = z.infer<typeof AuthorizationFormSchema>;
export const AuthorizationReviewSchema = z.object({
  allowedActions: z.array(z.string().min(1).max(256)).max(256),
  deniedActions: z.array(z.string().min(1).max(256)).max(256),
  resources: z.array(z.object({
    kind: z.string().min(1).max(256),
    values: z.array(z.string().max(4096)).max(1024).optional(),
    prefixValues: z.array(z.string().max(4096)).max(1024).optional(),
    payloadPath: z.array(z.string()).max(16).optional(),
    payloadPrefixPath: z.array(z.string()).max(16).optional(),
  }).strict()).max(256),
}).strict();

export function buildAuthorizationScope(form: AuthorizationForm, inputs: string[]): Record<string, unknown> {
  const validated = AuthorizationFormSchema.parse(form);
  const scope: Record<string, unknown> = {};
  validated.fields.forEach((field, index) => {
    // One literal per line. Do not infer schemes, wildcards, origins or prefixes.
    const values = (inputs[index] ?? "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (field.required && !values.length) throw new Error(`请填写${field.label}。`);
    if (values.length > field.maximumItems || values.some(value => value.length > field.maximumLength))
      throw new Error(`${field.label}超出数量或长度限制。`);
    let target = scope;
    for (const part of field.path.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
    target[field.path.at(-1)!] = values;
  });
  if (new TextEncoder().encode(JSON.stringify(scope)).length > 32768) throw new Error("授权范围超过 32 KiB，请缩小范围。");
  return scope;
}
