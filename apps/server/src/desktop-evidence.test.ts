import Fastify from "fastify";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import { FoundationHostControl } from "./foundation-host-control.js";
import { SqliteBrowserArtifactContent } from "./browser-artifact-content.js";
import { SqliteScenarioArtifactStore } from "./scenario-runtime-state.js";
import { registerDesktopEvidenceRoutes } from "./desktop-evidence.js";
import { SqliteDesktopEvidenceReader, desktopToolReceiptReference } from "./desktop-record-evidence.js";
import { archiveExecutionRow } from "./db/execution-archive.js";
import { createConversationBridge } from "../../desktop/src/conversation-bridge.js";
import { EVIDENCE_PAGE_BYTES } from "@traceforge/shared/desktop-evidence";

const cleanup: Array<() => Promise<void>> = [];

it("reads owned traffic in pages without headers and rejects changed snapshots", async () => {
  const f = await fixture();
  f.sql.prepare(`INSERT INTO traffic_entries (id,case_id,run_id,url,method,request_headers_json,response_headers_json,response_body,created_at)
    VALUES ('capture',?,'run','https://example.test','GET',?,?,?,'now')`)
    .run(f.conversation.caseId, '{"Authorization":"private-header"}', '{"Set-Cookie":"private-cookie"}', "x".repeat(70000));
  const request = { runId: "run", ref: "traffic:capture", offset: 0 };
  const response = await f.call(f.path, request);
  expect(response.statusCode).toBe(200);
  const page = response.json();
  const text = Buffer.from(page.bodyBase64, "base64").toString();
  expect(text).toContain("not guaranteed"); expect(text).not.toContain("private-header"); expect(text).not.toContain("private-cookie");
  expect(page.nextOffset).toBe(EVIDENCE_PAGE_BYTES);
  expect((await f.call(f.path, { ...request, offset: page.nextOffset })).statusCode).toBe(409);
  expect((await f.call(f.path, { ...request, offset: page.nextOffset, expectedDigest: page.digest })).statusCode).toBe(200);
  expect((await f.call(f.path, { ...request, runId: "other" })).statusCode).toBe(404);
  const other = (await f.call("/api/desktop/conversations", { commandId: "other", title: "Other" })).json();
  expect((await f.call(`/api/desktop/conversations/${other.id}/evidence/read`, request)).statusCode).toBe(404);
  f.sql.prepare("UPDATE traffic_entries SET response_body='changed' WHERE id='capture'").run();
  expect((await f.call(f.path, { ...request, expectedDigest: page.digest })).statusCode).toBe(409);
});

it("preserves knowledge invalidation and only reads receipts with an owned binding", async () => {
  const f = await fixture();
  f.sql.prepare(`INSERT INTO evidence_graph_nodes VALUES ('node',?,'run','hypothesis','Candidate','Not verified','invalidated',0.2,'{}',NULL,2,'now','now','now','contradicted')`).run(f.conversation.caseId);
  const node = (await f.call(f.path, { runId: "run", ref: "knowledge-node:node", offset: 0 })).json();
  expect(Buffer.from(node.bodyBase64, "base64").toString()).toContain('"invalidation_reason": "contradicted"');
  f.sql.prepare(`INSERT INTO worker_tool_receipts VALUES ('receipt',?,'now')`).run(JSON.stringify({ status: "success", summary: "Recorded", raw: { value: "original" }, refs: [] }));
  const request = { runId: "run", ref: "tool-receipt:receipt", offset: 0 };
  expect((await f.call(f.path, request)).statusCode).toBe(404);
  expect(desktopToolReceiptReference(f.sql, f.conversation.caseId, "run", "receipt")).toEqual([]);
  f.sql.prepare(`INSERT INTO tool_invocation_bindings VALUES ('receipt','invocation','fixture.read','fixture','1','contract','input',?,'run','work','completed',NULL,'now','now')`).run(f.conversation.caseId);
  const response = await f.call(f.path, request);
  expect(response.statusCode).toBe(200);
  expect(Buffer.from(response.json().bodyBase64, "base64").toString()).toContain('"value": "original"');
  expect((await f.call(f.path, { ...request, runId: "other" })).statusCode).toBe(404);
  expect((await f.call(f.path, { ...request, ref: "receipt" })).statusCode).toBe(200);
  expect(desktopToolReceiptReference(f.sql, f.conversation.caseId, "run", "receipt")).toEqual([request.ref]);
  expect(desktopToolReceiptReference(f.sql, "other", "run", "receipt")).toEqual([]);
  f.sql.transaction(() => archiveExecutionRow(f.sql, "receipt", "receipt", "now"))();
  const archived = await f.call(f.path, request);
  expect(archived.statusCode).toBe(200);
  expect(archived.json().digest).toBe(response.json().digest);
});

it("opens network receipts independently of response content without crossing owners", async () => {
  const f = await fixture();
  f.sql.prepare(`INSERT INTO execution_network_receipts VALUES
    ('receipt','local','request',?,'run','work','worker','scope','lease','key','grant','observe',
     'https://example.test','GET',200,0,40000,1,'fingerprint',0,'capture','start','end')`).run(f.conversation.caseId);
  const request = { runId: "run", ref: "network-receipt:receipt", offset: 0 };
  const response = await f.call(f.path, request);
  expect(response.statusCode).toBe(200);
  const content = Buffer.from(response.json().bodyBase64, "base64").toString();
  expect(content).toContain('"response_body_truncated": 1');
  expect(content).toContain('"authorization_ref": "grant"');
  expect((await f.call(f.path, { ...request, runId: "other" })).statusCode).toBe(404);
});
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function fixture(body = Buffer.from('<html><script>untrusted()</script>原始内容</html>')) {
  const app = Fastify(), db = createDb(":memory:"), sql = getSqliteClient(db);
  const channel = new FoundationHostControl(app, sql).management();
  registerConversationRoutes(app, db);
  const content = new SqliteBrowserArtifactContent(sql), index = new SqliteScenarioArtifactStore(sql);
  registerDesktopEvidenceRoutes(app, sql, new SqliteDesktopEvidenceReader(sql));
  await app.ready(); cleanup.push(async () => { await app.close(); sql.close(); });
  const call = (url: string, payload: object) => app.inject({ url, method: "POST", headers: channel.headers(), payload });
  const conversation = (await call("/api/desktop/conversations", { commandId: "first", title: "Evidence fixture" })).json();
  const input = { sessionId: "session", owner: { caseId: conversation.caseId, runId: "run", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease", leaseExpiresAt: "2099-01-01T00:00:00Z", authorizationAction: "observe" },
    kind: "dom" as const, view: { generation: 1, pageId: "page", documentId: "doc" }, mimeType: "text/plain",
    bodyBase64: body.toString("base64"), byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  const saved = content.persistArtifact("observation", input, value => index.record({ packageId: "fixture", packageVersion: "1", caseId: conversation.caseId,
    runId: "run", commandId: "record", kind: "browser.observation", summary: "Original observation", contentRef: value.ref,
    digest: `sha256:${input.sha256}`, byteSize: body.length, metadata: {} }));
  const artifact = index.list({ packageId: "fixture", packageVersion: "1", caseId: conversation.caseId, runId: "run", limit: 10 })[0]!;
  const path = `/api/desktop/conversations/${conversation.id}/evidence/read`;
  return { app, sql, call, path, saved, artifact, conversation, index, input, channel };
}
it("reads bound immutable evidence through the fenced desktop IPC with bounded pages", async () => {
  const original = Buffer.from("a".repeat(EVIDENCE_PAGE_BYTES - 1) + "正文");
  const f = await fixture(original);
  const bridge = createConversationBridge({ webContentsId: 7, origin: "http://127.0.0.1:12345", host: {
    request: async request => { const response = await f.app.inject({ url: request.path, method: request.method, payload: request.body, headers: { ...f.channel.headers(), "content-type": "application/json" } }); return { status: response.statusCode, body: response.json() }; },
  } });
  const sender = { webContentsId: 7, mainFrame: true, url: "http://127.0.0.1:12345/" };
  const first = await bridge.request(sender, { path: f.path, method: "POST", body: JSON.stringify({ runId: "run", ref: f.saved.ref, offset: 0 }) });
  expect(first.status).toBe(200);
  const page = first.body as any;
  expect(page.format).toBe("text"); expect(page.nextOffset).toBe(EVIDENCE_PAGE_BYTES);
  expect((await f.call(f.path, { runId: "run", ref: f.saved.ref, offset: page.nextOffset })).statusCode).toBe(409);
  const second = (await f.call(f.path, { runId: "run", ref: f.saved.ref, offset: page.nextOffset, expectedDigest: page.digest })).json();
  expect(second.nextOffset).toBeNull();
  expect(Buffer.concat([Buffer.from(page.bodyBase64, "base64"), Buffer.from(second.bodyBase64, "base64")])).toEqual(original);
});
it("rejects unauthenticated, cross-conversation, cross-run and forged artifact reads", async () => {
  const f = await fixture(), request = { runId: "run", ref: f.artifact.id, offset: 0 };
  expect((await f.app.inject({ url: f.path, method: "POST", payload: request })).statusCode).toBe(401);
  const other = (await f.call("/api/desktop/conversations", { commandId: "other", title: "Other" })).json();
  expect((await f.call(`/api/desktop/conversations/${other.id}/evidence/read`, request)).statusCode).toBe(404);
  expect((await f.call(f.path, { ...request, runId: "other" })).statusCode).toBe(404);
  const forged = f.index.record({ ...f.artifact, commandId: "forged", packageId: "other" });
  expect((await f.call(f.path, { ...request, ref: forged.id })).statusCode).toBe(404);
  for (const ref of ["/etc/passwd", "https://example.test", "file:///etc/passwd"]) expect((await f.call(f.path, { ...request, ref })).statusCode).toBe(404);
});
it("fails closed on changed digest, invalid offsets and corrupted content", async () => {
  const f = await fixture(), request = { runId: "run", ref: f.saved.ref, offset: 0 };
  expect((await f.call(f.path, { ...request, expectedDigest: `sha256:${"0".repeat(64)}` })).statusCode).toBe(409);
  expect((await f.call(f.path, { ...request, offset: 99999 })).statusCode).toBe(409);
  expect((await f.call(f.path, { ...request, caseId: "injected" })).statusCode).toBe(400);
  f.sql.exec("DROP TRIGGER browser_content_immutable");
  f.sql.prepare("UPDATE browser_artifact_content SET body=?").run(Buffer.from("corrupt"));
  const response = await f.call(f.path, request);
  expect(response.statusCode).toBe(409); expect(response.body).not.toContain("corrupt");
});
it("does not treat HTML/SVG as executable previews and bounds raster dimensions", async () => {
  const html = await fixture();
  expect((await html.call(html.path, { runId: "run", ref: html.saved.ref, offset: 0 })).json().format).toBe("text");
  const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(9000, 16); png.writeUInt32BE(9000, 20);
  const huge = await fixture(png);
  expect((await huge.call(huge.path, { runId: "run", ref: huge.saved.ref, offset: 0 })).json().format).toBe("binary");
  const valid = await fixture(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  expect((await valid.call(valid.path, { runId: "run", ref: valid.saved.ref, offset: 0 })).json().format).toBe("png");
});
