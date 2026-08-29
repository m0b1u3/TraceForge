import { randomUUID } from "node:crypto";

export type ToolProviderDiagnosticCategory = "process_exit" | "protocol" | "transport" | "remote_error";

export interface ToolProviderDiagnosticRecord {
  schemaVersion: 1;
  id: string;
  provider: { id: string; version: string; generation: number } | null;
  category: ToolProviderDiagnosticCategory;
  summary: string;
  detail: string;
  detailBytes: number;
  omittedDetailBytes: number;
  attribution: { caseId: string; runId: string; workId: string } | null;
  createdAt: string;
}

export interface ToolProviderDiagnosticWriter {
  write(record: ToolProviderDiagnosticRecord): void;
}

export function createToolProviderDiagnostic(input: {
  provider?: { id: string; version: string; generation: number } | null;
  category: ToolProviderDiagnosticCategory;
  summary: string;
  detail?: string;
  attribution?: { caseId: string; runId: string; workId: string } | null;
  maximumSummaryCharacters?: number;
  maximumDetailBytes?: number;
  previouslyOmittedDetailBytes?: number;
  now?: Date;
  id?: string;
}): ToolProviderDiagnosticRecord {
  const maximumSummaryCharacters = positive(input.maximumSummaryCharacters ?? 512, "summary character limit");
  const maximumDetailBytes = positive(input.maximumDetailBytes ?? 16 * 1024, "detail byte limit");
  const rawDetail = input.detail ?? "";
  const encoded = Buffer.from(rawDetail, "utf8");
  const detail = truncateUtf8(rawDetail, maximumDetailBytes);
  const detailBytes = Buffer.byteLength(detail, "utf8");
  return {
    schemaVersion: 1,
    id: input.id?.trim() || randomUUID(),
    provider: input.provider ? { ...input.provider } : null,
    category: input.category,
    summary: publicToolProviderDiagnosticSummary(input.summary, maximumSummaryCharacters),
    detail,
    detailBytes,
    omittedDetailBytes: Math.max(0, input.previouslyOmittedDetailBytes ?? 0) + Math.max(0, encoded.length - detailBytes),
    attribution: input.attribution ? { ...input.attribution } : null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export function publicToolProviderDiagnosticSummary(value: string, maximumCharacters = 512): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
    || "Tool Provider failure";
  return normalized.slice(0, positive(maximumCharacters, "summary character limit"));
}

export function diagnosticPublicMessage(record: ToolProviderDiagnosticRecord): string {
  return `${record.summary} (diagnostic: ${record.id})`;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Tool Provider diagnostic ${label} must be a positive integer`);
  return value;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}
