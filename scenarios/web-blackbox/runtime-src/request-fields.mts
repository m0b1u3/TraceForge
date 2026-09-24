import { plainObject, requiredBase64, requiredText } from "./validation.mjs";

/** Scenario-level HTTP experiment fields; never authorization or Core policy. */
export function experimentFields(request: Record<string, any>) {
  const method = requiredText(request.method ?? "GET", "Method").toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) throw new Error("Unsupported experiment method");
  const headers = request.headers === undefined ? {} : plainObject(request.headers, "Headers");
  const normalized: Record<string, string> = {};
  if (Object.keys(headers).length > 16) throw new Error("Too many headers");
  for (const name of Object.keys(headers).sort()) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(lower) || ["authorization", "proxy-authorization", "cookie", "set-cookie", "host"].includes(lower) || lower in normalized) {
      throw new Error("Use Host Sessions for credentials; header is invalid");
    }
    const value = requiredText(headers[name], "Header value");
    if (/[\r\n]/.test(value)) throw new Error("Invalid header value");
    normalized[lower] = value;
  }
  const body = request.bodyBase64 === undefined ? undefined : requiredBase64(request.bodyBase64);
  if (body !== undefined && Buffer.from(body, "base64").length > 65536) throw new Error("Experiment body exceeds 64 KiB");
  if (["GET", "HEAD"].includes(method) && (body || request.secretBody !== undefined)) throw new Error("GET/HEAD requests cannot carry a body");
  return { method, headers: normalized, ...(body === undefined ? {} : { bodyBase64: body }) };
}

export const experimentDimensions = ["url", "method", "sessionId", "headers", "bodyBase64"] as const;

export function changedDimensions(first: Record<string, any>, second: Record<string, any>) {
  return experimentDimensions.filter((key) =>
    JSON.stringify(first[key] ?? (key === "headers" ? {} : null)) !== JSON.stringify(second[key] ?? (key === "headers" ? {} : null)));
}
