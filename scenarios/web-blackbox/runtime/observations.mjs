import { shaBytes } from "./validation.mjs";
export function observationTerms(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 8 || value.some((term) => typeof term !== "string" || !term.trim() || term.length > 64)) {
        throw new Error("Expected at most eight bounded observation terms");
    }
    return [...new Set(value)];
}
export function normalizeObservation(row, terms = []) {
    const snippet = typeof row.snippet === "string" ? row.snippet
        : typeof row.bodyBase64 === "string" ? Buffer.from(row.bodyBase64, "base64").subarray(0, 4096).toString("utf8") : "";
    return {
        status: row.status,
        bytes: row.bytes ?? row.responseBytes,
        digest: row.bodySha256 ?? row.digest ?? row.bodyDigest
            ?? (typeof row.bodyBase64 === "string" ? shaBytes(Buffer.from(row.bodyBase64, "base64")) : undefined),
        truncated: row.truncated ?? row.bodyTruncated ?? false,
        refs: row.refs ?? row.evidenceRefs
            ?? [row.networkReceipt ?? row.receiptRef ?? (row.receipt?.id ? `network-receipt:${row.receipt.id}` : undefined)].filter(Boolean),
        snippet: snippet.slice(0, 256),
        matchedTerms: terms.filter((term) => snippet.toLowerCase().includes(term.toLowerCase())),
    };
}
/** Web-specific signatures; retain raw observations and independent receipts elsewhere. */
export function observationHighlights(rows, terms = []) {
    rows = rows.map((row) => normalizeObservation(row, terms));
    const groups = new Map();
    for (const [index, row] of rows.entries()) {
        const signature = JSON.stringify([row.status, row.bytes, row.bodySha256 ?? row.digest, row.truncated]);
        const group = groups.get(signature);
        if (group)
            group.count++;
        else
            groups.set(signature, { count: 1, first: index, representative: row });
    }
    const statusCounts = new Map(), lengthCounts = new Map();
    for (const row of rows) {
        statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
        lengthCounts.set(row.bytes, (lengthCounts.get(row.bytes) ?? 0) + 1);
    }
    for (const group of groups.values()) {
        group.representative.signals = {
            statusMinority: rows.length > 1 && (statusCounts.get(group.representative.status) ?? 0) < Math.max(...statusCounts.values()),
            lengthMinority: rows.length > 1 && (lengthCounts.get(group.representative.bytes) ?? 0) < Math.max(...lengthCounts.values()),
            termMatch: group.representative.matchedTerms.length > 0,
        };
    }
    const ordered = [...groups.values()].sort((a, b) => Number(b.representative.signals.termMatch) - Number(a.representative.signals.termMatch)
        || a.count - b.count || a.first - b.first);
    return {
        observationCount: rows.length, groupCount: groups.size, omittedGroups: Math.max(0, groups.size - 16), groups: ordered.slice(0, 16),
        limitation: "Signals describe only the bounded observation sample, not verified anomalies. Consult the referenced original receipts for full retained observations.",
    };
}
