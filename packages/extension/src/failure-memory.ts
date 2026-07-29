import type { ToolFailureDiagnostic } from "@traceforge/shared";

function stableStringify(value: unknown): string {
  if (value === undefined) return '"<undefined>"';
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

export function computeFailureFingerprint(tool: string, input: unknown): string {
  return `${tool}:${stableStringify(input)}`;
}

export interface FailureRecord {
  tool: string;
  input: unknown;
  diagnostic?: ToolFailureDiagnostic;
  observations?: number;
}

export interface BlockedFailure extends FailureRecord {
  diagnostic: ToolFailureDiagnostic;
  observations: number;
}

interface StoredFailure extends BlockedFailure {
  threshold: number;
}

const UNKNOWN_DIAGNOSTIC: ToolFailureDiagnostic = {
  category: "unknown",
  retryable: false,
  summary: "The tool reported a failure that could not be classified safely.",
  recommendation: "Inspect the raw result and change the input, tool, or approach instead of repeating the identical call.",
};

/**
 * Run-local memory that suppresses only genuinely identical failed calls.
 * A changed input, tool, or execution approach always has a distinct key.
 */
export class FailureMemory {
  private readonly records = new Map<string, StoredFailure>();

  constructor(records: FailureRecord[] = []) {
    for (const record of records) {
      const diagnostic = record.diagnostic ?? UNKNOWN_DIAGNOSTIC;
      const threshold = diagnostic.retryable ? 2 : 1;
      this.records.set(computeFailureFingerprint(record.tool, record.input), {
        tool: record.tool,
        input: record.input,
        diagnostic,
        observations: Math.max(record.observations ?? threshold, threshold),
        threshold,
      });
    }
  }

  has(tool: string, input: unknown): boolean {
    return this.getBlocked(tool, input) !== undefined;
  }

  getBlocked(tool: string, input: unknown): BlockedFailure | undefined {
    const record = this.records.get(computeFailureFingerprint(tool, input));
    if (!record || record.observations < record.threshold) return undefined;
    return {
      tool: record.tool,
      input: record.input,
      diagnostic: record.diagnostic,
      observations: record.observations,
    };
  }

  recordFailure(tool: string, input: unknown, diagnostic: ToolFailureDiagnostic): BlockedFailure | undefined {
    const fingerprint = computeFailureFingerprint(tool, input);
    const previous = this.records.get(fingerprint);
    const record: StoredFailure = {
      tool,
      input,
      diagnostic,
      observations: (previous?.observations ?? 0) + 1,
      threshold: diagnostic.retryable ? 2 : 1,
    };
    this.records.set(fingerprint, record);
    return this.getBlocked(tool, input);
  }

  /** @deprecated New runtime code should call recordFailure with a diagnostic. */
  add(tool: string, input: unknown, threshold = 1): void {
    const diagnostic = { ...UNKNOWN_DIAGNOSTIC, retryable: threshold > 1 };
    const fingerprint = computeFailureFingerprint(tool, input);
    const previous = this.records.get(fingerprint);
    this.records.set(fingerprint, {
      tool,
      input,
      diagnostic,
      observations: (previous?.observations ?? 0) + 1,
      threshold,
    });
  }

  resolve(tool: string, input: unknown): void {
    this.records.delete(computeFailureFingerprint(tool, input));
  }

  clearCategory(category: ToolFailureDiagnostic["category"]): void {
    for (const [fingerprint, record] of this.records) {
      if (record.diagnostic.category === category) this.records.delete(fingerprint);
    }
  }

  clear(): void {
    this.records.clear();
  }
}
