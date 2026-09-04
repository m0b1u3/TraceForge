import { createHash } from "node:crypto";
import type { JsonObject, ToolResult } from "./contracts.mjs";

export function plainObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

export function exact(value: JsonObject, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error("Unknown input field");
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 1024) throw new Error(`${label} is invalid`);
  return value.trim();
}

export function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} is invalid`);
  return value as number;
}

export function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = plainObject(value, label);
  if (Object.keys(record).length > 128 || Object.entries(record).some(([key, item]) => !key || typeof item !== "string")) {
    throw new Error(`${label} are invalid`);
  }
  return record as Record<string, string>;
}

export function requiredBase64(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2 * 1024 * 1024 || Buffer.from(value, "base64").toString("base64") !== value) {
    throw new Error("HTTP body is invalid");
  }
  return value;
}

export function canonicalHttpUrl(value: unknown, label: string): string {
  const text = requiredText(value, label);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label} must be an absolute HTTP URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${label} must be an HTTP URL without credentials`);
  url.hash = "";
  return url.href;
}

export function shaBytes(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function sha(value: string): string { return shaBytes(Buffer.from(value, "utf8")); }
export function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
export function succeeded(summary: string, output: unknown, refs: string[]): ToolResult {
  return { status: "succeeded", summary, raw: JSON.stringify(output), refs: unique(refs), retryable: false };
}
