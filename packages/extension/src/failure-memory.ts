function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

export function computeFailureFingerprint(tool: string, input: unknown): string {
  return `${tool}:${stableStringify(input)}`;
}

export interface FailureRecord {
  tool: string;
  input: unknown;
}

export class FailureMemory {
  private fingerprints = new Set<string>();

  constructor(records: FailureRecord[] = []) {
    for (const r of records) this.add(r.tool, r.input);
  }

  has(tool: string, input: unknown): boolean {
    return this.fingerprints.has(computeFailureFingerprint(tool, input));
  }

  add(tool: string, input: unknown): void {
    this.fingerprints.add(computeFailureFingerprint(tool, input));
  }
}
