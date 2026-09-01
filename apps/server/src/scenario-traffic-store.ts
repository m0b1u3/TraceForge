import type Database from "better-sqlite3";
import type { BrokeredNetworkReceipt } from "@traceforge/execution-node";

export interface ScenarioTrafficEntrySummary { id: string; runId: string; url: string; method: string;
  responseStatus: number | null; responseSize: number | null; contentType: string | null; createdAt: string; }
interface ScenarioTrafficPort {
  recordHttpExchange(input: { trafficId: string; caseId: string; runId: string; url: string; method: string;
    requestHeaders: Record<string, string>; requestBody: string | null; responseStatus: number;
    responseHeaders: Record<string, string>; responseSize: number; contentType: string | null; responseBody: string | null;
    receipt: BrokeredNetworkReceipt; createdAt: string }): void;
  recordBrowserObservation(input: { trafficId: string; caseId: string; runId: string; url: string;
    responseStatus: number | null; responseSize: number; responseBody: string; createdAt: string }): void;
  list(caseId: string, limit: number): ScenarioTrafficEntrySummary[];
}

export class SqliteScenarioTrafficStore implements ScenarioTrafficPort {
  constructor(private readonly sqlite: Database.Database) {}

  recordHttpExchange(input: Parameters<ScenarioTrafficPort["recordHttpExchange"]>[0]): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO traffic_entries
          (id, case_id, run_id, identity_id, identity_version, attribution_source, parent_traffic_id,
           url, method, request_headers_json, request_body, response_status, response_headers_json,
           response_size, content_type, response_body, created_at)
        VALUES (?, ?, ?, NULL, NULL, 'agent', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.trafficId, input.caseId, input.runId, input.url, input.method,
        JSON.stringify(input.requestHeaders), input.requestBody, input.responseStatus,
        JSON.stringify(input.responseHeaders), input.responseSize, input.contentType,
        input.responseBody, input.createdAt,
      );
      const receipt = input.receipt;
      this.sqlite.prepare(`
        INSERT INTO execution_network_receipts
          (id, node_id, request_id, case_id, run_id, work_id, worker_id, scope_ref, lease_id,
           idempotency_key, authorization_ref, authorization_action, url, method, status,
           request_bytes, response_bytes, response_body_truncated, permission_profile_fingerprint,
           redirect_followed, traffic_id, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.id, receipt.nodeId, receipt.requestId, receipt.attribution.caseId,
        receipt.attribution.runId, receipt.attribution.workId, receipt.attribution.workerId,
        receipt.attribution.scopeRef, receipt.attribution.leaseId, receipt.attribution.idempotencyKey,
        receipt.authorizationRef, receipt.authorizationAction, receipt.url, receipt.method,
        receipt.status, receipt.requestBytes, receipt.responseBytes,
        receipt.responseBodyTruncated ? 1 : 0, receipt.permissionProfileFingerprint,
        receipt.redirectFollowed ? 1 : 0, input.trafficId, receipt.startedAt, receipt.completedAt,
      );
    })();
  }

  recordBrowserObservation(input: Parameters<ScenarioTrafficPort["recordBrowserObservation"]>[0]): void {
    this.sqlite.prepare(`
      INSERT INTO traffic_entries
        (id, case_id, run_id, identity_id, identity_version, attribution_source, parent_traffic_id,
         url, method, request_headers_json, request_body, response_status, response_headers_json,
         response_size, content_type, response_body, created_at)
      VALUES (?, ?, ?, NULL, NULL, 'browser', NULL, ?, 'GET', '{}', NULL, ?, '{}', ?, 'text/html', ?, ?)
    `).run(
      input.trafficId, input.caseId, input.runId, input.url, input.responseStatus,
      input.responseSize, input.responseBody, input.createdAt,
    );
  }

  list(caseId: string, limit: number): ScenarioTrafficEntrySummary[] {
    const rows = this.sqlite.prepare(`
      SELECT id, run_id, url, method, response_status, response_size, content_type, created_at
      FROM traffic_entries WHERE case_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(caseId, limit) as Array<{
      id: string; run_id: string; url: string; method: string; response_status: number | null;
      response_size: number | null; content_type: string | null; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      url: row.url,
      method: row.method,
      responseStatus: row.response_status,
      responseSize: row.response_size,
      contentType: row.content_type,
      createdAt: row.created_at,
    }));
  }
}
