import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { readExecutionRow } from "./db/execution-archive.js";
import type { EvidenceSource } from "@traceforge/evidence-graph";
import { canonicalJson } from "@traceforge/orchestration-core";

/** All graph source types pass the same ownership boundary. Digests identify
 * the original stored observation, never the model's interpretation of it. */
export function executionSourceProvenance(sqlite: Database.Database, source: { type: "tool_result" | "traffic" | "artifact"; ref: string }, owner: { caseId: string; runId: string }): EvidenceSource {
  if (source.type === "tool_result") return toolReceiptProvenance(sqlite, source.ref, owner);
  if (source.type === "artifact") {
    const row = sqlite.prepare("SELECT digest,created_at,package_id,package_version FROM scenario_artifacts WHERE id=? AND case_id=? AND run_id=?")
      .get(source.ref, owner.caseId, owner.runId) as { digest: string; created_at: string; package_id: string; package_version: string } | undefined;
    if (!row) throw new Error("Evidence source artifact does not exist in the assigned Case/Run");
    if (!/^sha256:[a-f0-9]{64}$/.test(row.digest)) throw new Error("Evidence source artifact digest is invalid");
    return { ...source, observedAt: row.created_at, producerId: `${row.package_id}@${row.package_version}`,
      integrity: { algorithm: "sha256", digest: row.digest.slice(7) } };
  }
  const row = sqlite.prepare("SELECT * FROM traffic_entries WHERE id=? AND case_id=? AND run_id=?")
    .get(source.ref, owner.caseId, owner.runId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Evidence source traffic does not exist in the assigned Case/Run");
  if (!Number.isInteger(row.response_status)) throw new Error("Evidence traffic observation is not complete");
  return { ...source, observedAt: String(row.created_at), producerId: `traffic:${source.ref}`,
    integrity: { algorithm: "sha256", digest: createHash("sha256").update(canonicalJson(row)).digest("hex") } };
}

/** Read-only projection over existing receipt/binding ledgers, not a second
 * source of authority. A successful observation is still not a verified finding. */
export function toolReceiptProvenance(sqlite: Database.Database, key: string, owner: { caseId: string; runId: string }): EvidenceSource {
  const binding = sqlite.prepare(`SELECT tool_source,tool_version,invocation_id FROM tool_invocation_bindings
    WHERE idempotency_key=? AND case_id=? AND run_id=? AND status='completed'`).get(key, owner.caseId, owner.runId) as
    { tool_source: string; tool_version: string; invocation_id: string } | undefined;
  if (!binding) throw new Error("Evidence tool receipt does not belong to the assigned Case/Run or is not complete");
  const receipt = readExecutionRow<{ result_json: string; created_at: string }>(sqlite, "receipt", key);
  if (!receipt) throw new Error("Evidence tool result has no durable receipt");
  const result = JSON.parse(receipt.result_json);
  if (result.status !== "succeeded") throw new Error("Unsuccessful tool receipt cannot serve as observed evidence");
  return { type: "tool_result", ref: key, observedAt: receipt.created_at,
    producerId: `${binding.tool_source}@${binding.tool_version}:${binding.invocation_id}`,
    integrity: { algorithm: "sha256", digest: createHash("sha256").update(receipt.result_json).digest("hex") } };
}
