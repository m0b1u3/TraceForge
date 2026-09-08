import { z } from "zod";

const fieldName = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/).refine(value => !["constructor", "prototype"].includes(value));
const field = z.object({ type: z.enum(["string", "number", "boolean", "string_list"]), required: z.boolean(),
  values: z.array(z.string().max(4096)).min(1).max(128).optional() }).strict();
const schema = z.object({ version: z.literal(1), fields: z.record(fieldName, field),
  resources: z.array(z.object({ field: fieldName, kind: z.string().min(1).max(128) }).strict()).max(32),
}).strict();
export type McpInputPolicy = z.infer<typeof schema>;

/** A bounded data contract, not executable callbacks or a general JSON Schema interpreter. */
export function parseMcpInputPolicy(value: unknown): McpInputPolicy {
  const policy = schema.parse(value);
  if (Buffer.byteLength(JSON.stringify(policy)) > 32768 || Object.keys(policy.fields).length > 32) throw new Error("MCP input policy exceeds limit");
  for (const f of Object.values(policy.fields)) if (f.values && !["string", "string_list"].includes(f.type)) throw new Error("MCP value allowlist requires text fields");
  for (const resource of policy.resources) {
    const f = policy.fields[resource.field];
    if (!f?.required || !["string", "string_list"].includes(f.type)) throw new Error("MCP resource binding requires an explicit required text field");
  }
  return policy;
}

export function validateMcpPolicyInput(policy: McpInputPolicy, input: unknown): asserts input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error("Invalid MCP input");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some(name => !Object.hasOwn(policy.fields, name))) throw new Error("Unknown MCP input field");
  for (const [name, f] of Object.entries(policy.fields)) {
    if (!Object.hasOwn(record, name)) { if (f.required) throw new Error("Missing MCP input field"); continue; }
    const v = record[name];
    if (f.type === "string_list") {
      if (!Array.isArray(v) || v.length > 128 || v.some(text => typeof text !== "string" || Buffer.byteLength(text) > 4096 || f.values && !f.values.includes(text))) throw new Error("Invalid MCP text list");
    } else if (typeof v !== f.type || typeof v === "number" && !Number.isFinite(v)
      || typeof v === "string" && (Buffer.byteLength(v) > 4096 || f.values && !f.values.includes(v))) throw new Error("Invalid MCP field value");
  }
}

export function authorizeMcpPolicyInput(policy: McpInputPolicy, input: unknown, authorize: (kind: string, value: string) => string): void {
  validateMcpPolicyInput(policy, input);
  for (const resource of policy.resources) {
    const value = input[resource.field];
    const values = typeof value === "string" ? [value] : value as string[];
    if (!values.length) throw new Error("MCP resource list cannot be empty");
    for (const candidate of values) if (!candidate || authorize(resource.kind, candidate) !== candidate) throw new Error("MCP resource is not authorized");
  }
}
