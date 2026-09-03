import type { ScenarioOutput, ScenarioRunState } from "@traceforge/orchestration-core";
import type { ScenarioEvidenceNodeRecord } from "./index.js";

export interface ScenarioScopePolicyV1 {
  format: "traceforge.scenario-scope-policy.v1";
  allowedActions: readonly string[];
  deniedActions: readonly string[];
  payload: { maximumBytes: number; maximumDepth: number };
  resources: readonly {
    kind: string;
    values?: readonly string[];
    payloadPath?: readonly string[];
    /** Explicit lexical namespaces. The policy never infers URL, path, ARN, or other domain semantics. */
    prefixValues?: readonly string[];
    payloadPrefixPath?: readonly string[];
  }[];
}

export interface ScenarioEvidenceMappingV1 {
  kind: ScenarioEvidenceNodeRecord["kind"];
  status: ScenarioEvidenceNodeRecord["status"];
  confidence: number;
  title: { source: "output.summary" } | { literal: string };
  summary: { source: "output.summary" } | { literal: string };
  properties?: Readonly<Record<string,
    { source: "output.id" | "output.kind" | "output.summary" | "output.refs" | "run.id" | "run.caseId" }
    | { literal: string | number | boolean | null }>>;
}

export interface ScenarioOutputContractV1 {
  kind: string;
  version: number;
  format: "traceforge.scenario-output-contract.v1";
  maximumSummaryBytes: number;
  maximumRefs: number;
  referencePrefixes?: readonly string[];
  evidence?: ScenarioEvidenceMappingV1;
}

export function isDeclarativeScopePolicy(value: unknown): value is ScenarioScopePolicyV1 {
  return Boolean(value && typeof value === "object" && (value as { format?: unknown }).format === "traceforge.scenario-scope-policy.v1");
}

export function isDeclarativeOutputContract(value: unknown): value is ScenarioOutputContractV1 {
  return Boolean(value && typeof value === "object" && (value as { format?: unknown }).format === "traceforge.scenario-output-contract.v1");
}
export function assertDeclarativeScopePolicy(policy: ScenarioScopePolicyV1): void { validatePolicy(policy); }
export function assertDeclarativeOutputContract(contract: ScenarioOutputContractV1): void { validateOutputContract(contract); }

export function parseDeclarativeScope(policy: ScenarioScopePolicyV1, input: unknown) {
  validatePolicy(policy);
  const payload = cloneJson(input, policy.payload.maximumBytes, policy.payload.maximumDepth, "Scenario scope payload");
  return { payload, allowedActions: [...policy.allowedActions], deniedActions: [...policy.deniedActions] };
}

export function authorizeDeclarativeResource(policy: ScenarioScopePolicyV1, payload: unknown, resourceKind: string, value: string): string {
  validatePolicy(policy);
  const rules = policy.resources.filter((rule) => rule.kind === resourceKind);
  for (const rule of rules) {
    if (rule.values?.includes(value)) return value;
    if (rule.payloadPath) {
      const selected = readPath(payload, rule.payloadPath);
      if (selected === value || (Array.isArray(selected) && selected.includes(value))) return value;
    }
    const prefixes=rule.prefixValues??(rule.payloadPrefixPath?readStringList(payload,rule.payloadPrefixPath):[]);
    if(prefixes.some(prefix=>value.startsWith(prefix)))return value;
  }
  throw new Error(`Scenario scope does not authorize ${resourceKind} resource`);
}

export function validateDeclarativeOutput(contract: ScenarioOutputContractV1, output: ScenarioOutput): void {
  validateOutputContract(contract);
  if (output.kind !== contract.kind || output.schemaVersion !== contract.version) throw new Error("Scenario output contract identity mismatch");
  if (typeof output.summary !== "string" || !Array.isArray(output.refs) || output.refs.some((ref) => typeof ref !== "string" || Buffer.byteLength(ref) > 4096)
    || Buffer.byteLength(output.summary) > contract.maximumSummaryBytes || output.refs.length > contract.maximumRefs) {
    throw new Error("Scenario output exceeds its declarative contract");
  }
  if (contract.referencePrefixes?.length) {
    if (output.refs.some((ref) => !contract.referencePrefixes!.some((prefix) => ref.startsWith(prefix)))) {
      throw new Error("Scenario output reference violates its declarative contract");
    }
  }
}

export function mapDeclarativeEvidence(contract: ScenarioOutputContractV1, run: ScenarioRunState,
  output: ScenarioOutput): ScenarioEvidenceNodeRecord | null {
  validateDeclarativeOutput(contract, output);
  const mapping = contract.evidence;
  if (!mapping) return null;
  if (!Number.isFinite(mapping.confidence) || mapping.confidence < 0 || mapping.confidence > 1) throw new Error("Invalid evidence confidence");
  const properties = Object.fromEntries(Object.entries(mapping.properties ?? {}).map(([key, selector]) => {
    if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(key)) throw new Error("Invalid evidence property name");
    return [key, "literal" in selector ? selector.literal : select(selector.source, run, output)];
  }));
  return { id: output.id, kind: mapping.kind, title: render(mapping.title, output), summary: render(mapping.summary, output),
    status: mapping.status, confidence: mapping.confidence, properties };
}

function validatePolicy(policy: ScenarioScopePolicyV1): void {
  record(policy, "Declarative scope policy");
  exact(policy,["format","allowedActions","deniedActions","payload","resources"]);
  if (policy.format !== "traceforge.scenario-scope-policy.v1") throw new Error("Invalid declarative scope policy format");
  record(policy.payload, "Declarative scope payload limits");
  exact(policy.payload,["maximumBytes","maximumDepth"]);
  if (!Number.isSafeInteger(policy.payload.maximumBytes) || policy.payload.maximumBytes < 2 || policy.payload.maximumBytes > 1024 * 1024
    || !Number.isSafeInteger(policy.payload.maximumDepth) || policy.payload.maximumDepth < 1 || policy.payload.maximumDepth > 32) {
    throw new Error("Invalid declarative scope payload limits");
  }
  if (!Array.isArray(policy.allowedActions) || !Array.isArray(policy.deniedActions)) throw new Error("Invalid declarative scope actions");
  const identifiers = [...policy.allowedActions, ...policy.deniedActions];
  if (identifiers.length > 256 || identifiers.some((value) => !identifier(value)) || new Set(identifiers).size !== identifiers.length) {
    throw new Error("Invalid declarative scope actions");
  }
  if (!Array.isArray(policy.resources) || policy.resources.length > 256 || policy.resources.some((rule) => {
    if (!plainRecord(rule)) return true;
    exact(rule,["kind","values","payloadPath","prefixValues","payloadPrefixPath"]);
    const selectors=[rule.values,rule.payloadPath,rule.prefixValues,rule.payloadPrefixPath].filter(value=>value!==undefined);
    return !identifier(rule.kind)
    || (rule.values !== undefined && !Array.isArray(rule.values))
    || (rule.payloadPath !== undefined && !Array.isArray(rule.payloadPath))
    || (rule.prefixValues !== undefined && !Array.isArray(rule.prefixValues))
    || (rule.payloadPrefixPath !== undefined && !Array.isArray(rule.payloadPrefixPath))
    || selectors.length!==1 || (rule.values?.length ?? 0) > 1024 || (rule.prefixValues?.length ?? 0)>1024
    || rule.values?.some((value: string) => typeof value !== "string" || Buffer.byteLength(value) > 4096)
    || rule.prefixValues?.some((value:string)=>typeof value!=="string"||!value||Buffer.byteLength(value)>4096)
    || rule.payloadPath?.length === 0 || (rule.payloadPath?.length ?? 0) > 16
    || rule.payloadPrefixPath?.length === 0 || (rule.payloadPrefixPath?.length ?? 0)>16
    || rule.payloadPath?.some((part: string) => !/^[a-zA-Z0-9_.:-]{1,128}$/.test(part))
    || rule.payloadPrefixPath?.some((part:string)=>!/^[a-zA-Z0-9_.:-]{1,128}$/.test(part));
  })) throw new Error("Invalid declarative resource rule");
}

function validateOutputContract(contract: ScenarioOutputContractV1): void {
  record(contract, "Declarative output contract");
  exact(contract,["kind","version","format","maximumSummaryBytes","maximumRefs","referencePrefixes","evidence"]);
  if (contract.format !== "traceforge.scenario-output-contract.v1" || !identifier(contract.kind) || !Number.isSafeInteger(contract.version) || contract.version < 1
    || !Number.isSafeInteger(contract.maximumSummaryBytes) || contract.maximumSummaryBytes < 1 || contract.maximumSummaryBytes > 64 * 1024
    || !Number.isSafeInteger(contract.maximumRefs) || contract.maximumRefs < 0 || contract.maximumRefs > 1024) {
    throw new Error("Invalid declarative output contract");
  }
  if (contract.referencePrefixes !== undefined && !Array.isArray(contract.referencePrefixes)) {
    throw new Error("Invalid declarative output reference prefixes");
  }
  if ((contract.referencePrefixes?.length ?? 0) > 64 || contract.referencePrefixes?.some((value) => typeof value !== "string" || !value || Buffer.byteLength(value) > 256)) {
    throw new Error("Invalid declarative output reference prefixes");
  }
  const evidence=contract.evidence;
  if(evidence){
    record(evidence, "Declarative evidence mapping");
    exact(evidence,["kind","status","confidence","title","summary","properties"]);exactTextSelector(evidence.title);exactTextSelector(evidence.summary);
    const kinds=new Set(["entity","fact","hypothesis","evidence","task","validation_conclusion","finding","limitation"]);
    const statuses=new Set(["active","candidate","validating","verified","refuted","blocked","resolved","needs_review","invalidated"]);
    if(!kinds.has(evidence.kind)||!statuses.has(evidence.status)||!Number.isFinite(evidence.confidence)
      || evidence.confidence<0 || evidence.confidence>1 || Object.keys(evidence.properties??{}).length>64
      || ("literal" in evidence.title && Buffer.byteLength(evidence.title.literal)>1024)
      || ("literal" in evidence.summary && Buffer.byteLength(evidence.summary.literal)>64*1024))throw new Error("Invalid declarative evidence mapping");
    if (evidence.properties !== undefined && !plainRecord(evidence.properties)) throw new Error("Invalid declarative evidence properties");
    for(const [key,selector] of Object.entries(evidence.properties??{})){
      if(!/^[a-z][a-z0-9_.:-]{0,127}$/.test(key))throw new Error("Invalid evidence property name");
      exactSelector(selector);
    }
  }
}

function cloneJson(value: unknown, maximumBytes: number, maximumDepth: number, label: string): unknown {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON`); }
  if (encoded === undefined || Buffer.byteLength(encoded) > maximumBytes) throw new Error(`${label} exceeds its capacity`);
  const parsed: unknown = JSON.parse(encoded);
  const visit = (item: unknown, depth: number): void => {
    if (depth > maximumDepth) throw new Error(`${label} exceeds its depth`);
    if (item && typeof item === "object") for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(parsed, 0); return parsed;
}
function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
function readStringList(value:unknown,path:readonly string[]):string[]{
  const selected=readPath(value,path);if(typeof selected==="string")return selected?[selected]:[];
  return Array.isArray(selected)&&selected.length<=1024&&selected.every(item=>typeof item==="string"&&item.length>0&&Buffer.byteLength(item)<=4096)
    ?selected:[];
}
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(value); }
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!plainRecord(value)) throw new Error(`${label} must be a plain object`);
}
function exact(value:object,keys:readonly string[]):void{const allowed=new Set(keys);if(Object.keys(value).some(key=>!allowed.has(key)))throw new Error("Unknown declarative contract field");}
function exactSelector(value:{source?:unknown;literal?:unknown}):void{
  record(value, "Declarative selector");
  exact(value,["source","literal"]);if(("source" in value)===("literal" in value))throw new Error("Invalid declarative selector");
  if("source" in value&&!new Set(["output.id","output.kind","output.summary","output.refs","run.id","run.caseId"]).has(String(value.source)))throw new Error("Invalid declarative selector source");
  if("literal" in value&&(!(["string","number","boolean"].includes(typeof value.literal)||value.literal===null)
    || typeof value.literal==="string"&&Buffer.byteLength(value.literal)>64*1024
    || typeof value.literal==="number"&&!Number.isFinite(value.literal)))throw new Error("Invalid declarative selector literal");
}
function exactTextSelector(value:{source?:unknown;literal?:unknown}):void{
  exactSelector(value);
  if("source" in value&&value.source!=="output.summary")throw new Error("Invalid declarative text selector source");
  if("literal" in value&&typeof value.literal!=="string")throw new Error("Invalid declarative text selector literal");
}
function render(value: ScenarioEvidenceMappingV1["title"], output: ScenarioOutput): string { return "literal" in value ? value.literal : output.summary; }
function select(source: "output.id" | "output.kind" | "output.summary" | "output.refs" | "run.id" | "run.caseId",
  run: ScenarioRunState, output: ScenarioOutput): unknown {
  return source === "output.id" ? output.id : source === "output.kind" ? output.kind : source === "output.summary" ? output.summary
    : source === "output.refs" ? [...output.refs] : source === "run.id" ? run.id : run.caseId;
}
