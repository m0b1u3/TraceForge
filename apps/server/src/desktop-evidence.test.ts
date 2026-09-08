import Fastify from "fastify";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import { FoundationHostControl } from "./foundation-host-control.js";
import { SqliteBrowserArtifactContent } from "./browser-artifact-content.js";
import { SqliteScenarioArtifactStore } from "./scenario-runtime-state.js";
import { registerDesktopEvidenceRoutes, SqliteDesktopBrowserEvidenceReader } from "./desktop-evidence.js";
import { createConversationBridge } from "../../desktop/src/conversation-bridge.js";
import { EVIDENCE_PAGE_BYTES } from "@traceforge/shared/desktop-evidence";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function fixture(body = Buffer.from('<html><script>untrusted()</script>原始内容</html>')) {
  const app = Fastify(), db = createDb(":memory:"), sql = getSqliteClient(db);
  const channel = new FoundationHostControl(app, sql).management();
  registerConversationRoutes(app, db);
  const content = new SqliteBrowserArtifactContent(sql), index = new SqliteScenarioArtifactStore(sql);
  registerDesktopEvidenceRoutes(app, sql, new SqliteDesktopBrowserEvidenceReader(sql));
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
