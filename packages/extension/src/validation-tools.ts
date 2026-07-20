import type { TrafficEntry } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export type ValidationVerdict = "supports" | "refutes" | "inconclusive";

export interface ValidationAssessment {
  verdict: ValidationVerdict;
  confidence: number;
  signals: string[];
  missingEvidence: string[];
  metrics: {
    statusChanged: boolean;
    lengthDelta: number;
    structureSimilarity: number;
    scalarOverlap: number;
  };
}

export interface ValidationTrafficReader {
  listByCase(caseId: string): TrafficEntry[];
}

function parseJson(body: string | null | undefined): unknown {
  if (!body?.trim()) return undefined;
  try { return JSON.parse(body); } catch { return undefined; }
}

function flatten(value: unknown, prefix = "", output = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, output));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flatten(item, prefix ? `${prefix}.${key}` : key, output);
    }
  } else if (prefix) {
    output.set(prefix, JSON.stringify(value));
  }
  return output;
}

function ratio(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1;
  const union = new Set([...left, ...right]);
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return union.size ? intersection / union.size : 0;
}

function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

export function assessValidationExperiment(input: {
  baseline: TrafficEntry;
  variant: TrafficEntry;
  protectedFields?: string[];
  confirmation?: TrafficEntry;
  expectedBusinessState?: Record<string, unknown>;
}): ValidationAssessment {
  const { baseline, variant } = input;
  const baselineJson = parseJson(baseline.responseBody);
  const variantJson = parseJson(variant.responseBody);
  const baselineFlat = flatten(baselineJson);
  const variantFlat = flatten(variantJson);
  const structureSimilarity = ratio(new Set(baselineFlat.keys()), new Set(variantFlat.keys()));
  const baselineScalars = new Set([...baselineFlat.values()].filter((value) => value !== "null"));
  const variantScalars = new Set([...variantFlat.values()].filter((value) => value !== "null"));
  const scalarOverlap = ratio(baselineScalars, variantScalars);
  const metrics = {
    statusChanged: baseline.responseStatus !== variant.responseStatus,
    lengthDelta: Math.abs((baseline.responseSize ?? baseline.responseBody?.length ?? 0) - (variant.responseSize ?? variant.responseBody?.length ?? 0)),
    structureSimilarity: Number(structureSimilarity.toFixed(4)),
    scalarOverlap: Number(scalarOverlap.toFixed(4)),
  };
  const signals: string[] = [];
  const missingEvidence: string[] = [];
  const baselineSuccess = (baseline.responseStatus ?? 0) >= 200 && (baseline.responseStatus ?? 0) < 300;
  const variantStatus = variant.responseStatus ?? 0;
  const variantSuccess = variantStatus >= 200 && variantStatus < 300;
  const variantDenied = [401, 403, 404].includes(variantStatus);
  const method = baseline.method.toUpperCase();
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  if (!baselineSuccess) {
    return {
      verdict: "inconclusive",
      confidence: 0.2,
      signals: ["Baseline did not produce a successful authorized response."],
      missingEvidence: ["Capture a stable authorized baseline before interpreting the variant."],
      metrics,
    };
  }
  if (variantDenied) {
    return {
      verdict: "refutes",
      confidence: 0.9,
      signals: [`Variant was denied with HTTP ${variantStatus} while baseline succeeded.`],
      missingEvidence,
      metrics,
    };
  }
  if (mutating) {
    if (!variantSuccess) {
      return {
        verdict: "refutes",
        confidence: 0.75,
        signals: [`Mutation variant did not succeed (HTTP ${variantStatus}).`],
        missingEvidence,
        metrics,
      };
    }
    const confirmationJson = parseJson(input.confirmation?.responseBody);
    if (!input.confirmation || !input.expectedBusinessState || !Object.keys(input.expectedBusinessState).length) {
      return {
        verdict: "inconclusive",
        confidence: 0.45,
        signals: ["Mutation returned success, but transport success does not prove a business-state change."],
        missingEvidence: ["Provide a follow-up read traffic ID and expectedBusinessState fields."],
        metrics,
      };
    }
    const compared = Object.entries(input.expectedBusinessState);
    const matched = compared.filter(([path, expected]) =>
      JSON.stringify(valueAt(confirmationJson, path)) === JSON.stringify(expected));
    if (matched.length === compared.length) {
      signals.push(`Follow-up read confirmed ${matched.length} expected business-state field(s).`);
      return { verdict: "supports", confidence: 0.95, signals, missingEvidence, metrics };
    }
    return {
      verdict: "inconclusive",
      confidence: 0.5,
      signals: ["Follow-up read did not confirm every expected business-state field."],
      missingEvidence: ["Confirm the affected resource and expected state using a stable read endpoint."],
      metrics,
    };
  }

  const protectedFields = input.protectedFields ?? [];
  if (protectedFields.length) {
    const comparable = protectedFields.filter((path) =>
      valueAt(baselineJson, path) !== undefined && valueAt(variantJson, path) !== undefined);
    const exposed = comparable.filter((path) =>
      JSON.stringify(valueAt(baselineJson, path)) === JSON.stringify(valueAt(variantJson, path)));
    if (exposed.length) {
      return {
        verdict: "supports",
        confidence: 0.95,
        signals: [`Variant exposed matching protected field(s): ${exposed.join(", ")}.`],
        missingEvidence,
        metrics,
      };
    }
    if (!comparable.length) missingEvidence.push("Protected fields were not present in both responses.");
    else signals.push("Protected fields differed between baseline and variant.");
    return { verdict: comparable.length ? "refutes" : "inconclusive", confidence: comparable.length ? 0.8 : 0.35, signals, missingEvidence, metrics };
  }

  if (variantSuccess && structureSimilarity >= 0.8 && scalarOverlap >= 0.6 && baselineScalars.size > 0) {
    return {
      verdict: "supports",
      confidence: 0.75,
      signals: ["Variant returned a materially equivalent structured response to the authorized baseline."],
      missingEvidence: ["Specify protectedFields to raise confidence and identify the exposed asset precisely."],
      metrics,
    };
  }
  return {
    verdict: "inconclusive",
    confidence: 0.35,
    signals: variantSuccess ? ["Both responses succeeded, but protected content equivalence was not established."] : [`Variant returned HTTP ${variantStatus}.`],
    missingEvidence: ["Specify protectedFields or collect a clearer baseline/variant differential."],
    metrics,
  };
}

export function makeAssessValidationExperimentTool(caseId: string, traffic: ValidationTrafficReader): ToolDescriptor {
  return {
    name: "assess_validation_experiment",
    description: "Assess a persisted baseline/variant traffic pair as supports, refutes, or inconclusive. HTTP 200 alone never proves a vulnerability; mutations require follow-up business-state confirmation.",
    risk: "normal",
    source: "builtin",
    inputSchema: {
      type: "object",
      properties: {
        baselineTrafficId: { type: "string" },
        variantTrafficId: { type: "string" },
        protectedFields: { type: "array", items: { type: "string" } },
        confirmationTrafficId: { type: "string" },
        expectedBusinessState: { type: "object" },
      },
      required: ["baselineTrafficId", "variantTrafficId"],
    },
    execute: async (raw) => {
      const input = raw as {
        baselineTrafficId?: string;
        variantTrafficId?: string;
        protectedFields?: string[];
        confirmationTrafficId?: string;
        expectedBusinessState?: Record<string, unknown>;
      };
      const entries = traffic.listByCase(caseId);
      const baseline = entries.find((entry) => entry.id === input.baselineTrafficId);
      const variant = entries.find((entry) => entry.id === input.variantTrafficId);
      const confirmation = entries.find((entry) => entry.id === input.confirmationTrafficId);
      if (!baseline || !variant) return { ok: false, content: "baselineTrafficId and variantTrafficId must reference traffic in this case" };
      if (input.confirmationTrafficId && !confirmation) return { ok: false, content: "confirmationTrafficId must reference traffic in this case" };
      return {
        ok: true,
        content: JSON.stringify(assessValidationExperiment({
          baseline,
          variant,
          protectedFields: input.protectedFields,
          confirmation,
          expectedBusinessState: input.expectedBusinessState,
        }), null, 2),
      };
    },
  };
}
