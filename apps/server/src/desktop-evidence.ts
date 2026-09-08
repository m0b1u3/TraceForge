import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { DesktopEvidenceReadSchema, EVIDENCE_MAX_BYTES, EVIDENCE_PAGE_BYTES,
  type DesktopEvidencePage, type DesktopEvidenceRead } from "@traceforge/shared/desktop-evidence";

export interface DesktopEvidenceReader {
  read(caseId: string, request: DesktopEvidenceRead): DesktopEvidencePage | undefined;
}

/** Human audit reader, not an Agent tool grant. Only immutable, bound local
 * Browser artifacts are supported; references never become paths or URLs. */
export class SqliteDesktopBrowserEvidenceReader implements DesktopEvidenceReader {
  constructor(private readonly db: Database.Database) {}
  read(caseId: string, request: DesktopEvidenceRead): DesktopEvidencePage | undefined {
    if (!["browser_artifact_content", "browser_content_bindings"].every(name =>
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))) return undefined;
    const row = this.db.prepare(`SELECT a.id, a.summary, a.kind, a.digest, a.byte_size, c.body, c.digest AS content_digest
      FROM scenario_artifacts a JOIN browser_content_bindings b ON b.artifact_id=a.id AND b.content_ref=a.content_ref
      JOIN browser_artifact_content c ON c.ref=b.content_ref AND c.case_id=a.case_id AND c.run_id=a.run_id
      WHERE a.case_id=? AND a.run_id=? AND (a.id=? OR a.content_ref=?) ORDER BY a.id LIMIT 1`)
      .get(caseId, request.runId, request.ref, request.ref) as
      { id: string; summary: string; kind: string; digest: string; byte_size: number; body: Buffer; content_digest: string } | undefined;
    if (!row) return undefined;
    const body = row.body;
    if (!Buffer.isBuffer(body) || body.length > EVIDENCE_MAX_BYTES || body.length !== row.byte_size
      || `sha256:${createHash("sha256").update(body).digest("hex")}` !== row.digest || `sha256:${row.content_digest}` !== row.digest)
      throw new Error("Evidence integrity failure");
    if (request.expectedDigest && request.expectedDigest !== row.digest) throw new Error("Evidence identity changed");
    if (request.offset > body.length) throw new Error("Evidence offset out of range");
    const end = Math.min(body.length, request.offset + EVIDENCE_PAGE_BYTES);
    return { runId: request.runId, ref: request.ref, artifactId: row.id, summary: row.summary, kind: row.kind,
      digest: row.digest, byteSize: body.length, format: evidenceFormat(body), offset: request.offset,
      nextOffset: end < body.length ? end : null, bodyBase64: body.subarray(request.offset, end).toString("base64") };
  }
}

function evidenceFormat(body: Buffer): DesktopEvidencePage["format"] {
  // Only bounded PNG raster data may be embedded. HTML/SVG are always inert text.
  if (body.length >= 33 && body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && body.readUInt32BE(8) === 13 && body.toString("ascii", 12, 16) === "IHDR") {
    const width = body.readUInt32BE(16), height = body.readUInt32BE(20);
    if (width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16777216) return "png";
    return "binary";
  }
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ? "binary" : "text";
  } catch { return "binary"; }
}

/** Protected by the existing local host transport fence. The host resolves
 * conversation ownership; the renderer cannot supply case or package identity. */
export function registerDesktopEvidenceRoutes(app: FastifyInstance, db: Database.Database, reader: DesktopEvidenceReader) {
  app.post("/api/desktop/conversations/:conversationId/evidence/read", async (request, reply) => {
    const conversationId = (request.params as { conversationId: string }).conversationId;
    const parsed = DesktopEvidenceReadSchema.safeParse(request.body);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId) || !parsed.success) return reply.code(400).send({ error: "invalid_evidence_read" });
    const owner = db.prepare("SELECT case_id AS caseId FROM desktop_conversations WHERE id=?").get(conversationId) as { caseId: string } | undefined;
    if (!owner) return reply.code(404).send({ error: "evidence_unavailable" });
    try {
      const page = reader.read(owner.caseId, parsed.data);
      if (!page) return reply.code(404).send({ error: "evidence_unavailable" });
      reply.header("Cache-Control", "no-store");
      return page;
    } catch { return reply.code(409).send({ error: "evidence_unreadable" }); }
  });
}
