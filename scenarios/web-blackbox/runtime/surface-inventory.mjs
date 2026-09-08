import { plainObject, requiredText, sha, unique } from "./validation.mjs";
const catalogKey = "web.surface.catalog.v1";
export const surfaceKey = (sessionId) => sessionId ? `web.surface.v1:${sha(sessionId).slice(0, 16)}` : "web.surface.v1";
export async function registerInventory(capability, sessionId) {
    const loaded = await capability("traceforge.scenario.state@1", "read", { operation: "read", key: catalogKey }, "inventory-read");
    const entries = catalog(loaded.output?.value);
    const key = surfaceKey(sessionId);
    if (entries.some(item => item.key === key))
        return;
    if (entries.length >= 16)
        throw new Error("Surface inventory limit reached; report coverage instead of replacing identities");
    entries.push({ key, sessionId });
    const revision = loaded.output?.revision ?? 0;
    await capability("traceforge.scenario.state@1", "compare_and_set", { operation: "compare_and_set", key: catalogKey,
        commandId: `inventory:${revision}`, expectedRevision: revision, value: { version: 1, entries } }, `inventory-save:${revision}`);
}
export async function readInventories(capability, candidateKeys = []) {
    const loaded = await capability("traceforge.scenario.state@1", "read", { operation: "read", key: catalogKey }, "inventory-read");
    const entries = catalog(loaded.output?.value);
    const keys = unique(["web.surface.v1", ...entries.map(item => item.key), ...candidateKeys]);
    const inventories = [];
    for (const key of keys) {
        if (!/^web\.surface\.v1(?::[a-f0-9]{16})?$/.test(key))
            throw new Error("Invalid surface inventory key");
        const record = await capability("traceforge.scenario.state@1", "read", { operation: "read", key }, `inventory:${key}`);
        const state = record.output?.value;
        if (state == null)
            continue;
        if (state.schemaVersion !== 1 || ![state.visited, state.queue, state.observations, state.skipped].every(Array.isArray))
            throw new Error("Invalid surface inventory checkpoint");
        inventories.push({ key, sessionId: entries.find(item => item.key === key)?.sessionId ?? null,
            mode: key === "web.surface.v1" ? "anonymous" : "session", visitedCount: state.visited.length, queuedCount: state.queue.length,
            retainedObservationCount: state.observations.length, skipped: state.skipped, pending: state.pending ?? null,
            queued: state.queue, omissions: state.omissions ?? null, coverageAccounting: state.omissions ? "tracked" : "legacy_unknown",
            observations: state.observations.map((item) => ({ url: item.url, status: item.status, contentType: item.contentType,
                bodyTruncated: item.bodyTruncated, networkReceipt: item.networkReceipt, evidenceRefs: item.evidenceRefs ?? [],
                formCount: item.forms?.length ?? 0, hintsTruncated: item.hintsTruncated ?? null })),
            complete: false });
    }
    return { inventories, catalogAvailable: loaded.output != null,
        limitations: ["Inventories are bounded and never prove exhaustive coverage.",
            "Pre-catalog Session inventories without a registered candidate may be absent; Session handles do not grant permission to reuse them in another Work."] };
}
function catalog(value) {
    if (value == null)
        return [];
    const state = plainObject(value, "Surface catalog");
    if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 16)
        throw new Error("Invalid surface catalog");
    return state.entries.map(item => {
        const entry = plainObject(item, "Surface inventory");
        const sessionId = entry.sessionId === null ? null : requiredText(entry.sessionId, "Inventory Session");
        if (entry.key !== surfaceKey(sessionId))
            throw new Error("Invalid inventory binding");
        return { key: entry.key, sessionId };
    });
}
