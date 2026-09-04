import { createHash } from "node:crypto";
export function plainObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}
export function exact(value, allowed) {
    const keys = new Set(allowed);
    if (Object.keys(value).some((key) => !keys.has(key)))
        throw new Error("Unknown input field");
}
export function requiredText(value, label) {
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 1024)
        throw new Error(`${label} is invalid`);
    return value.trim();
}
export function boundedInteger(value, minimum, maximum, label) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${label} is invalid`);
    return value;
}
export function stringRecord(value, label) {
    const record = plainObject(value, label);
    if (Object.keys(record).length > 128 || Object.entries(record).some(([key, item]) => !key || typeof item !== "string")) {
        throw new Error(`${label} are invalid`);
    }
    return record;
}
export function requiredBase64(value) {
    if (typeof value !== "string" || Buffer.byteLength(value) > 2 * 1024 * 1024 || Buffer.from(value, "base64").toString("base64") !== value) {
        throw new Error("HTTP body is invalid");
    }
    return value;
}
export function canonicalHttpUrl(value, label) {
    const text = requiredText(value, label);
    let url;
    try {
        url = new URL(text);
    }
    catch {
        throw new Error(`${label} must be an absolute HTTP URL`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error(`${label} must be an HTTP URL without credentials`);
    url.hash = "";
    return url.href;
}
export function shaBytes(value) { return createHash("sha256").update(value).digest("hex"); }
export function sha(value) { return shaBytes(Buffer.from(value, "utf8")); }
export function unique(values) { return [...new Set(values)]; }
export function succeeded(summary, output, refs) {
    return { status: "succeeded", summary, raw: JSON.stringify(output), refs: unique(refs), retryable: false };
}
