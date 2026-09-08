import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { readEvidencePage, evidenceText, evidencePng } from "./evidence-client";
import { EVIDENCE_PAGE_BYTES } from "@traceforge/shared/desktop-evidence";

afterEach(() => vi.unstubAllGlobals());
function fixture(body = Buffer.from("原始文本"), format: "text" | "png" | "binary" = "text") {
  vi.stubGlobal("crypto", webcrypto);
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const request = vi.fn(async (input: { body?: string }) => {
    const { offset } = JSON.parse(input.body!); const end = Math.min(body.length, offset + EVIDENCE_PAGE_BYTES);
    return { status: 200, body: { runId: "run", ref: "ref", artifactId: "artifact", kind: "browser.observation", summary: "Observation", digest,
      byteSize: body.length, format, offset, nextOffset: end < body.length ? end : null, bodyBase64: body.subarray(offset, end).toString("base64") } };
  });
  return { bridge: { protocolVersion: 1 as const, request }, request, digest };
}
it("reassembles byte pages across UTF-8 boundaries and verifies the full digest", async () => {
  const body = Buffer.from("a".repeat(EVIDENCE_PAGE_BYTES - 1) + "中文"), f = fixture(body);
  const first = await readEvidencePage(f.bridge, "conversation", "run", "ref");
  expect(first.verified).toBe(false); expect(evidenceText(first)).not.toContain("�");
  const second = await readEvidencePage(f.bridge, "conversation", "run", "ref", first);
  expect(second.verified).toBe(true); expect(evidenceText(second)).toBe(body.toString());
  expect(JSON.parse(f.request.mock.calls[1]![0].body!)).toMatchObject({ offset: EVIDENCE_PAGE_BYTES, expectedDigest: f.digest });
});
it("rejects reordered, skipped, changed and corrupt pages", async () => {
  for (const patch of [{ offset: 1 }, { ref: "other" }, { digest: `sha256:${"0".repeat(64)}` }, { nextOffset: 0 }, { bodyBase64: "%%%" },
    { byteSize: 100, bodyBase64: "YQ==", nextOffset: 1 }]) {
    const f = fixture(), request = f.request;
    const bridge = { ...f.bridge, request: async (input: { body?: string }) => {
      const response = await request(input); return { ...response, body: { ...response.body, ...patch } };
    } };
    await expect(readEvidencePage(bridge, "conversation", "run", "ref")).rejects.toThrow();
  }
});
it("ignores an in-flight response after cancellation", async () => {
  const abort = new AbortController(), f = fixture();
  const bridge = { ...f.bridge, request: async (input: { body?: string }) => { const response = await f.request(input); abort.abort(); return response; } };
  await expect(readEvidencePage(bridge, "conversation", "run", "ref", undefined, abort.signal)).rejects.toThrow();
});
it("never treats text/HTML or incomplete data as an embeddable image", async () => {
  const f = fixture(Buffer.from('<script>alert("untrusted")</script>'));
  const value = await readEvidencePage(f.bridge, "conversation", "run", "ref");
  expect(evidencePng(value)).toBeUndefined();
  expect(evidenceText(value)).toContain("<script>");
  expect(evidencePng({ ...value, verified: false, page: { ...value.page, format: "png" } })).toBeUndefined();
});
it("embeds only the complete digest-verified PNG bytes", async () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const f = fixture(Buffer.from(base64, "base64"), "png");
  const value = await readEvidencePage(f.bridge, "conversation", "run", "ref");
  expect(evidencePng(value)).toBe(`data:image/png;base64,${base64}`);
});
