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
  return `${tool}:${stableStringify(normalizeFailureInput(tool, input))}`;
}

function payloadClass(value: string): string {
  const text = value.toLowerCase();
  if (/(\bor\b|\band\b).*(=|like)|union\s+select|sleep\s*\(|benchmark\s*\(/i.test(text)) return "<sql-injection>";
  if (/<script|javascript:|onerror\s*=|onload\s*=/i.test(text)) return "<xss>";
  if (/\.\.[\\/]|%2e%2e/i.test(text)) return "<path-traversal>";
  if (/\$\{jndi:|ldap:\/\//i.test(text)) return "<jndi-injection>";
  return value;
}

function normalizeFailureInput(tool: string, input: unknown): unknown {
  if (typeof input === "string") return payloadClass(input);
  if (Array.isArray(input)) return input.map((value) => normalizeFailureInput(tool, value));
  if (typeof input !== "object" || input === null) return input;
  const record = input as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "caseId") continue;
    if (typeof value === "string" && ["url", "body", "requestBody", "payload", "command"].includes(key)) {
      if (key === "url") {
        try {
          const url = new URL(value);
          for (const [name, parameter] of url.searchParams) url.searchParams.set(name, payloadClass(parameter));
          normalized[key] = url.toString();
        } catch {
          normalized[key] = payloadClass(value);
        }
      } else {
        normalized[key] = payloadClass(value);
      }
    } else {
      normalized[key] = normalizeFailureInput(tool, value);
    }
  }
  return normalized;
}

export interface FailureRecord {
  tool: string;
  input: unknown;
}

export class FailureMemory {
  private fingerprints = new Set<string>();
  private observations = new Map<string, number>();

  constructor(records: FailureRecord[] = []) {
    for (const r of records) this.add(r.tool, r.input);
  }

  has(tool: string, input: unknown): boolean {
    return this.fingerprints.has(computeFailureFingerprint(tool, input));
  }

  add(tool: string, input: unknown, threshold = 1): void {
    const fingerprint = computeFailureFingerprint(tool, input);
    const count = (this.observations.get(fingerprint) ?? 0) + 1;
    this.observations.set(fingerprint, count);
    if (count >= threshold) this.fingerprints.add(fingerprint);
  }

  clear(): void {
    this.fingerprints.clear();
    this.observations.clear();
  }
}
