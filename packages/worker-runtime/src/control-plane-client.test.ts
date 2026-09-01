import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HttpWorkerControlPlaneClient } from "./control-plane-client.js";
import { LeaseLostError } from "./runtime.js";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } });
async function endpoint(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); done(); });
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return `http://127.0.0.1:${address.port}`;
}
describe("Bounded Worker control-plane transport", () => {
  it("uses actual HTTP and escapes worker identities", async () => {
    let path = "";
    const url = await endpoint((request, response) => { path = request.url!; response.end("[]"); });
    expect(await new HttpWorkerControlPlaneClient(url).assignments("first/worker")).toEqual([]);
    expect(path).toBe("/api/scenarios/workers/first%2Fworker/assignments");
  });
  it.each(["headers", "body"])("aborts when %s never completes", async (phase) => {
    const url = await endpoint((_request, response) => { if (phase === "body") { response.writeHead(200, { "content-type": "application/json" }); response.write("["); } });
    const start = Date.now();
    await expect(new HttpWorkerControlPlaneClient(url, fetch, { timeoutMs: 60 }).assignments("worker")).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });
  it.each(["declared", "streamed"])("rejects %s oversized responses", async (mode) => {
    const url = await endpoint((_request, response) => {
      response.writeHead(200, mode === "declared" ? { "content-length": "4096" } : {});
      response.end(JSON.stringify(["x".repeat(2048)]));
    });
    await expect(new HttpWorkerControlPlaneClient(url, fetch, { maximumResponseBytes: 128 }).assignments("worker")).rejects.toThrow("size limit");
  });
  it("refuses oversized requests before opening a connection", async () => {
    let calls = 0; const url = await endpoint((_request, response) => { calls++; response.end("{}"); });
    await expect(new HttpWorkerControlPlaneClient(url, fetch, { maximumRequestBytes: 8 }).register({ id: "worker", roles: [], capabilities: [],
      maxConcurrentWork: 1, status: "online", heartbeatAt: new Date().toISOString() })).rejects.toThrow("request exceeds");
    expect(calls).toBe(0);
  });
  it("does not redirect Worker commands to a different endpoint", async () => {
    let targetCalls = 0; const target = await endpoint((_request, response) => { targetCalls++; response.end("[]"); });
    const url = await endpoint((_request, response) => { response.writeHead(307, { location: target }); response.end(); });
    await expect(new HttpWorkerControlPlaneClient(url).assignments("worker")).rejects.toThrow(); expect(targetCalls).toBe(0);
  });
  it.each([403, 404, 409])("retains lease-loss semantics for HTTP %i", async (code) => {
    const url = await endpoint((_request, response) => { response.writeHead(code); response.end(JSON.stringify({ error: "Lease unavailable" })); });
    await expect(new HttpWorkerControlPlaneClient(url).assignments("worker")).rejects.toBeInstanceOf(LeaseLostError);
  });
  it("rejects malformed success JSON without echoing its body", async () => {
    const url = await endpoint((_request, response) => response.end("private-invalid-response"));
    await expect(new HttpWorkerControlPlaneClient(url).assignments("worker")).rejects.toThrow("invalid JSON");
  });
  it("bounds error messages and leaves transient errors retryable by the caller", async () => {
    const url = await endpoint((_request, response) => { response.writeHead(503); response.end(JSON.stringify({ error: "x".repeat(5000) })); });
    try { await new HttpWorkerControlPlaneClient(url).assignments("worker"); throw new Error("Expected failure"); }
    catch (error) { expect(error).not.toBeInstanceOf(LeaseLostError); expect((error as Error).message).toHaveLength(1024); }
  });
  it.each([{ timeoutMs: 0 }, { timeoutMs: 60001 }, { maximumResponseBytes: NaN }, { maximumRequestBytes: 16777217 }])("rejects invalid limits %j", (limits) => {
    expect(() => new HttpWorkerControlPlaneClient("http://127.0.0.1", fetch, limits)).toThrow("Invalid Worker");
  });
});
