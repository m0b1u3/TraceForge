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
    type: z.enum(["string-list", "boolean", "integer"]),
    minimum: z.number().int().nonnegative().optional(),
    maximum: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    defaultValue: z.number().int().nonnegative().optional(),
    defaultEnabled: z.boolean().optional(),
    required: z.boolean(),
    advanced: z.boolean().optional(),
    suggestion: z.literal("message-urls").optional(),
    maximumItems: z.number().int().min(1).max(128).default(1),
    maximumLength: z.number().int().min(1).max(4096).default(4096),
  }).strict()).min(1).max(24),
}).strict().superRefine((form, context) => {
  for (const field of form.fields) if (field.defaultEnabled !== undefined && field.type !== "boolean")
    context.addIssue({code:"custom",message:"Only boolean fields may declare defaultEnabled"});
  for (const field of form.fields) if (field.type === "integer" && (field.minimum === undefined || field.maximum === undefined
    || field.minimum > field.maximum || field.defaultValue !== undefined && (field.defaultValue < field.minimum || field.defaultValue > field.maximum))) {
    context.addIssue({code:"custom",message:"Integer authorization fields require valid bounds and an in-range default when supplied"});
  }
  for (let i = 0; i < form.fields.length; i++) for (let j = i + 1; j < form.fields.length; j++) {
    const a = form.fields[i]!.path, b = form.fields[j]!.path;
    if (a.slice(0, Math.min(a.length, b.length)).every((part, index) => part === b[index]))
      context.addIssue({ code: "custom", message: "Overlapping authorization fields" });
  }
});
export type AuthorizationForm = z.infer<typeof AuthorizationFormSchema>;
export const AuthorizationReviewSchema = z.object({
  actionSelection: z.boolean().optional(),
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
    if (field.required && (field.type === "boolean" ? inputs[index] !== "true" : !values.length)) throw new Error(`请填写${field.label}。`);
    if (values.length > field.maximumItems || values.some(value => value.length > field.maximumLength))
      throw new Error(`${field.label}超出数量或长度限制。`);
    if (field.type === "integer" && !field.required && !values.length && field.defaultValue === undefined) return;
    let target = scope;
    for (const part of field.path.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
    target[field.path.at(-1)!] = values;
    if (field.type === "boolean") {
      if (![undefined, "", "false", "true"].includes(inputs[index])) throw new Error(`请确认${field.label}。`);
      target[field.path.at(-1)!] = inputs[index] === "true";
    }
    if (field.type === "integer") {
      const text=inputs[index]??String(field.defaultValue);
      const number=Number(text);
      if(!/^\d+$/.test(text)||!Number.isSafeInteger(number)||number<field.minimum!||number>field.maximum!)throw new Error(`${field.label}必须是 ${field.minimum}–${field.maximum} 之间的整数。`);
      target[field.path.at(-1)!]=number;
    }
  });
  if (new TextEncoder().encode(JSON.stringify(scope)).length > 32768) throw new Error("授权范围超过 32 KiB，请缩小范围。");
  return scope;
}

export const TaskDefinitionSchema = z.object({ kind:z.string(), version:z.number(), title:z.string().optional(), authorizationForm:AuthorizationFormSchema, authorizationReview:AuthorizationReviewSchema }).passthrough();
export const TaskDefinitionsSchema = z.array(TaskDefinitionSchema);
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;
export const TaskPresetSchema = z.object({identity:z.string(),revision:z.number().int().nonnegative(),inputs:z.array(z.string()),actions:z.array(z.string())}).strict();
export const TaskPresetsSchema = z.array(z.object({kind:z.string(),preset:TaskPresetSchema,default:z.boolean().optional()}).strict());
/** Selection belongs to desktop settings, never to model-generated task arguments. */
export function selectedTaskKind(raw:string|null,available:readonly {kind:string}[]):string|undefined {
  const selected=raw===null?[]:TaskPresetsSchema.parse(JSON.parse(raw)).filter(row=>row.default);
  if(selected.length>1)throw new Error("请在设置中选择一个默认场景。");
  if(selected.length)return selected[0]!.kind;
  return available.length===1?available[0]!.kind:undefined;
}
export type TaskPreset = z.infer<typeof TaskPresetSchema>;

export const taskDefinitionIdentity = (d:TaskDefinition) => JSON.stringify([d.version,d.authorizationForm,d.authorizationReview]);
export function defaultTaskConfiguration(d:TaskDefinition):TaskPreset {
  return {identity:taskDefinitionIdentity(d),revision:0,inputs:d.authorizationForm.fields.map(f=>f.type==="boolean"?String(f.defaultEnabled??false):f.type==="integer"?String(f.defaultValue??""):""),actions:d.authorizationReview.allowedActions.filter(a=>!d.authorizationReview.deniedActions.includes(a))};
}
export function resolveTaskConfiguration(d:TaskDefinition,raw:string|null):TaskPreset {
  const saved=raw===null?undefined:TaskPresetsSchema.parse(JSON.parse(raw)).find(row=>row.kind===d.kind)?.preset;
  if(saved&&saved.identity!==taskDefinitionIdentity(d))throw new Error("场景配置已变化，请在设置 → 任务执行中核对并保存偏好。");
  return saved??defaultTaskConfiguration(d);
}
export function taskConfigurationScope(d:TaskDefinition,p:TaskPreset,inputs=p.inputs) {
  if(p.identity!==taskDefinitionIdentity(d)||inputs.length!==d.authorizationForm.fields.length||p.actions.some(a=>!d.authorizationReview.allowedActions.includes(a)||d.authorizationReview.deniedActions.includes(a)))throw new Error("任务配置不匹配，请重新读取设置。");
  return {...buildAuthorizationScope(d.authorizationForm,inputs),...(d.authorizationReview.actionSelection?{authorizedActions:[...p.actions]}:{})};
}
