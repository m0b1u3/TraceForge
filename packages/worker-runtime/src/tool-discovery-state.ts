import { createHash } from "node:crypto";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { ExecutionToolSpec } from "./model.js";

export interface ExecutionToolDiscoveryFailure {
  message: string;
  at: string;
}

export interface ExecutionToolDiscoverySnapshot {
  schemaVersion: 1;
  source: string;
  revision: number;
  outcome: "ready" | "degraded";
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  lastFailure: ExecutionToolDiscoveryFailure | null;
  lastSuccessfulCatalog: ExecutionToolSpec[];
  catalogFingerprint: string | null;
  updatedAt: string;
}

export interface ExecutionToolDiscoveryStatePort {
  load(source: string): Promise<ExecutionToolDiscoverySnapshot | undefined>;
  save(snapshot: ExecutionToolDiscoverySnapshot): Promise<void>;
}

export function executionToolCatalogFingerprint(catalog: readonly ExecutionToolSpec[]): string | null {
  if (catalog.length === 0) return null;
  const ordered = [...catalog].sort((left, right) =>
    left.source.localeCompare(right.source) || left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}

export function parseExecutionToolDiscoverySnapshot(value: unknown, expectedSource?: string): ExecutionToolDiscoverySnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.source !== "string" || !value.source.trim()
    || (expectedSource !== undefined && value.source !== expectedSource)
    || !Number.isInteger(value.revision) || Number(value.revision) < 1
    || !["ready", "degraded"].includes(String(value.outcome))
    || !timestamp(value.lastAttemptAt) || !nullableTimestamp(value.lastSuccessAt)
    || !timestamp(value.updatedAt) || !Array.isArray(value.lastSuccessfulCatalog)) {
    throw new Error("Stored tool discovery state is invalid");
  }
  const source = value.source;
  const catalog = value.lastSuccessfulCatalog.map((entry) => parseSpec(entry, source));
  const fingerprint = executionToolCatalogFingerprint(catalog);
  if (value.catalogFingerprint !== fingerprint) throw new Error("Stored tool discovery catalog fingerprint does not match its contents");
  const lastFailure = parseFailure(value.lastFailure);
  if (value.outcome === "ready" && (!value.lastSuccessAt || lastFailure !== null)) {
    throw new Error("Stored ready tool discovery state has inconsistent lifecycle fields");
  }
  if (value.outcome === "degraded" && lastFailure === null) {
    throw new Error("Stored degraded tool discovery state requires a failure reason");
  }
  return {
    schemaVersion: 1,
    source: value.source,
    revision: Number(value.revision),
    outcome: value.outcome as "ready" | "degraded",
    lastAttemptAt: value.lastAttemptAt,
    lastSuccessAt: value.lastSuccessAt as string | null,
    lastFailure,
    lastSuccessfulCatalog: catalog,
    catalogFingerprint: fingerprint,
    updatedAt: value.updatedAt,
  };
}

export function snapshotToolSpec(spec: ExecutionToolSpec): ExecutionToolSpec {
  return {
    name: spec.name,
    source: spec.source,
    version: spec.version,
    priority: spec.priority,
    description: spec.description,
    inputSchema: jsonClone(spec.inputSchema),
    providedCapabilities: [...spec.providedCapabilities],
    dependencyCapabilities: [...spec.dependencyCapabilities],
    permissionRequirements: jsonClone(spec.permissionRequirements),
    risk: spec.risk,
    timeoutMs: spec.timeoutMs,
  };
}

function parseSpec(value: unknown, source: string): ExecutionToolSpec {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()
    || value.source !== source || typeof value.version !== "string" || !value.version.trim()
    || typeof value.priority !== "number" || !Number.isFinite(value.priority)
    || typeof value.description !== "string" || !isRecord(value.inputSchema)
    || !stringArray(value.providedCapabilities) || !stringArray(value.dependencyCapabilities)
    || !isRecord(value.permissionRequirements)
    || !["read_only", "bounded_write", "privileged", "destructive"].includes(String(value.risk))
    || !Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1) {
    throw new Error("Stored tool discovery catalog contains an invalid tool specification");
  }
  return snapshotToolSpec(value as unknown as ExecutionToolSpec);
}

function parseFailure(value: unknown): ExecutionToolDiscoveryFailure | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.message !== "string" || !value.message || value.message.length > 1_024 || !timestamp(value.at)) {
    throw new Error("Stored tool discovery failure is invalid");
  }
  return { message: value.message, at: value.at };
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && Boolean(entry.trim()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonClone<T>(value: T): T {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value is not JSON serializable");
    return JSON.parse(encoded) as T;
  } catch (error) {
    throw new Error(`Tool discovery catalog metadata is not JSON serializable: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
