/** Deliberately bounded record contracts, not a general JSON Schema interpreter. */
export interface SkillRecordContract {
  fields: Record<string, { type: "string" | "number" | "boolean" | "string_list"; required: boolean; enum?: string[] }>;
}
export interface ScenarioSkillContract {
  version: number;
  input: SkillRecordContract;
  output: SkillRecordContract;
  /** Mechanical completion criteria only; never a security verification verdict. */
  checks: Array<{ id: string; field: string; equals: string | number | boolean }>;
}

export function validateSkillContract(contract: ScenarioSkillContract): void {
  if (JSON.stringify(contract).length > 4096 || !Number.isSafeInteger(contract.version) || contract.version < 1
    || Object.keys(contract).some((k) => !["version", "input", "output", "checks"].includes(k))
    || !Array.isArray(contract.checks) || !contract.checks.length || contract.checks.length > 16) throw new Error("Invalid Skill contract budget");
  for (const shape of [contract.input, contract.output]) {
    if (!shape?.fields || typeof shape.fields !== "object" || Array.isArray(shape.fields) || Object.keys(shape.fields).length > 32
      || Object.keys(shape).some((k) => k !== "fields")) throw new Error("Invalid Skill fields");
    for (const [name, field] of Object.entries(shape.fields)) {
      if (!field || Object.keys(field).some((k) => !["type", "required", "enum"].includes(k))
        || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(name) || !["string", "number", "boolean", "string_list"].includes(field.type)
        || typeof field.required !== "boolean" || (field.enum !== undefined && (field.type !== "string" || !Array.isArray(field.enum)
          || !field.enum.length || field.enum.length > 32 || field.enum.some((v) => typeof v !== "string" || v.length > 128)))) throw new Error("Invalid Skill field");
    }
  }
  const ids = new Set<string>();
  for (const check of contract.checks) {
    const field = contract.output.fields[check.field];
    if (Object.keys(check).some((k) => !["id", "field", "equals"].includes(k))
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(check.id) || ids.has(check.id) || !field || !field.required
      || typeof check.equals !== field.type || (typeof check.equals === "number" && !Number.isFinite(check.equals))
      || (field.enum && !field.enum.includes(String(check.equals)))) throw new Error("Invalid Skill completion criterion");
    ids.add(check.id);
  }
}

export function validateSkillRecord(shape: SkillRecordContract, input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 2048) throw new Error("Invalid Skill record");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !Object.hasOwn(shape.fields, key))) throw new Error("Unknown Skill field");
  for (const [key, field] of Object.entries(shape.fields)) {
    if (!Object.hasOwn(value, key)) { if (field.required) throw new Error("Missing Skill field"); continue; }
    const item = value[key];
    if (field.type === "string_list" ? !Array.isArray(item) || item.length > 32 || item.some((v) => typeof v !== "string" || v.length > 512)
      : typeof item !== field.type || (typeof item === "number" && !Number.isFinite(item))
        || (typeof item === "string" && item.length > 1024) || (field.enum !== undefined && !field.enum.includes(String(item)))) throw new Error("Invalid Skill field value");
  }
}
