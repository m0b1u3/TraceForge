import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { EVIDENCE_MAX_BYTES, EVIDENCE_PAGE_BYTES, type DesktopEvidenceRead, type DesktopEvidencePage } from "@traceforge/shared/desktop-evidence";
import { SqliteDesktopBrowserEvidenceReader, type DesktopEvidenceReader } from "./desktop-evidence.js";
import { readExecutionRow } from "./db/execution-archive.js";

export function desktopToolReceiptReference(db: Database.Database, caseId: string, runId: string, key: string): string[] {
  const ref = `tool-receipt:${key}`;
  if (ref.length > 256) return [];
  return db.prepare(`SELECT 1 FROM tool_invocation_bindings b JOIN worker_tool_receipts r USING(idempotency_key)
    WHERE b.idempotency_key=? AND b.case_id=? AND b.run_id=?`).get(key, caseId, runId) ? [ref] : [];
}

/** Local human inspection only. A readable record is not a verified finding or
 * an Agent capability grant. References are database identities, never paths. */
export class SqliteDesktopEvidenceReader implements DesktopEvidenceReader {
  private readonly browser: SqliteDesktopBrowserEvidenceReader;
  constructor(private readonly db: Database.Database) { this.browser = new SqliteDesktopBrowserEvidenceReader(db); }

  read(caseId: string, request: DesktopEvidenceRead): DesktopEvidencePage | undefined {
    const browser = this.browser.read(caseId, request);
    if (browser) return browser;
    let record: unknown;
    let kind: string;
    if (request.ref.startsWith("network-receipt:")) {
      kind = "network.receipt";
      record = this.db.prepare("SELECT * FROM execution_network_receipts WHERE id=? AND case_id=? AND run_id=?")
        .get(request.ref.slice("network-receipt:".length), caseId, request.runId);
    } else if (request.ref.startsWith("traffic:")) {
      kind = "network.traffic";
      // Do not export credential-bearing headers. Persisted bodies may already
      // be excerpts: wire response size does not prove complete body capture.
      record = this.db.prepare(`SELECT id, url, method, response_status, response_size, content_type,
        request_body, response_body, created_at FROM traffic_entries WHERE id=? AND case_id=? AND run_id=?`)
        .get(request.ref.slice("traffic:".length), caseId, request.runId);
      if (record) record = { bodyCoverage: "saved content; not guaranteed to be the full wire capture", headersOmitted: true, record };
    } else if (request.ref.startsWith("knowledge-node:")) {
      kind = "knowledge.node";
      const row = this.db.prepare(`SELECT * FROM evidence_graph_nodes WHERE id=? AND case_id=? AND
        (run_id=? OR (run_id IS NULL AND EXISTS (SELECT 1 FROM scenario_event_streams WHERE run_id=? AND case_id=?)))`)
        .get(request.ref.slice("knowledge-node:".length), caseId, request.runId, request.runId, caseId) as Record<string, unknown> | undefined;
      if (row) {
        const { properties_json, source_json, ...fields } = row;
        record = { ...fields, properties: JSON.parse(String(properties_json)), source: source_json ? JSON.parse(String(source_json)) : null };
      }
    } else {
      kind = "tool.receipt";
      const key = request.ref.startsWith("tool-receipt:") ? request.ref.slice("tool-receipt:".length) : request.ref;
      const binding = this.db.prepare(`SELECT invocation_id, tool_name, tool_source, tool_version, status, work_id
        FROM tool_invocation_bindings WHERE idempotency_key=? AND case_id=? AND run_id=?`).get(key, caseId, request.runId);
      if (binding) {
        const receipt = readExecutionRow<{ result_json: string }>(this.db, "receipt", key);
        if (receipt) record = { binding, result: JSON.parse(receipt.result_json) };
      }
    }
    if (!record) return undefined;
    const body = Buffer.from(JSON.stringify({ notice: "Stored record only; opening it does not verify a finding.", record }, null, 2));
    if (body.length > EVIDENCE_MAX_BYTES) throw new Error("Evidence too large");
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    if ((request.offset > 0 && !request.expectedDigest) || (request.expectedDigest && request.expectedDigest !== digest))
      throw new Error("Evidence identity changed or missing");
    if (request.offset > body.length) throw new Error("Evidence offset out of range");
    const end = Math.min(body.length, request.offset + EVIDENCE_PAGE_BYTES);
    return { runId: request.runId, ref: request.ref, artifactId: request.ref, summary: "已保存记录（不代表已验证）", kind,
      digest, byteSize: body.length, format: "text", offset: request.offset, nextOffset: end < body.length ? end : null,
      bodyBase64: body.subarray(request.offset, end).toString("base64") };
  }
}
