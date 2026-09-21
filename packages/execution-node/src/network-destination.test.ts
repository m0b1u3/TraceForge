import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { isPublicAddress, resolveNetworkDestination } from "./network-destination.js";
import { requestPinnedHttp } from "./pinned-http.js";
const grant = (canonicalUrl: string) => ({ canonicalUrl, authorizationRef: "scope", expiresAt: "2099-01-01T00:00:00.000Z" });
const signal = () => AbortSignal.timeout(3000);
it("enforces address bindings against every answer, including public rebinding and IPv6 spellings", async () => {
  const options = {authorize:grant,signal:signal(),allowedAddresses:["0:0:0:0:0:0:0:1"],resolve:async()=>[{address:"::1",family:6}]};
  expect((await resolveNetworkDestination("https://first.example/",options)).address).toBe("::1");
  await expect(resolveNetworkDestination("https://first.example/",{...options,resolve:async()=>[{address:"::1",family:6},{address:"8.8.8.8",family:4}]})).rejects.toThrow("address binding");
});
it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1", "fc00::1", "2001:db8::1", "64:ff9b::a00:1"])("requires explicit address scope for %s", address => {
  expect(isPublicAddress(address)).toBe(false);
});
it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("recognizes global address %s", address => expect(isPublicAddress(address)).toBe(true));
it("checks every A/AAAA and refuses a private address hidden behind a domain grant", async () => {
  const authorize = vi.fn((url: string) => { if (url !== "https://first.example/") throw new Error("outside address scope"); return grant(url); });
  await expect(resolveNetworkDestination("https://first.example/", { authorize, signal: signal(), resolve: async () => [
    { address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 },
  ] })).rejects.toThrow("outside address scope");
  expect(authorize).toHaveBeenCalledWith("https://[::1]/");
});
it("retains explicitly authorized private destinations without a blanket private-network ban", async () => {
  const destination = await resolveNetworkDestination("https://first.example/path", { authorize: grant, signal: signal(),
    resolve: async () => [{ address: "10.1.2.3", family: 4 }] });
  expect(destination).toMatchObject({ hostname: "first.example", address: "10.1.2.3", port: 443, addressAuthorizationRefs: ["scope"] });
  await expect(resolveNetworkDestination("https://first.example/path", { authorize: grant, signal: signal(), publicOnly: true,
    resolve: async () => [{ address: "10.1.2.3", family: 4 }] })).rejects.toThrow("non-public");
});
it("rechecks revocation after resolution and bounds hanging DNS", async () => {
  let revoked = false;
  await expect(resolveNetworkDestination("https://first.example/", { authorize: url => { if (revoked) throw new Error("revoked"); return grant(url); },
    signal: signal(), resolve: async () => { revoked = true; return [{ address: "8.8.8.8", family: 4 }]; } })).rejects.toThrow("revoked");
  await expect(resolveNetworkDestination("https://first.example/", { authorize: grant, signal: AbortSignal.timeout(20), resolve: () => new Promise(() => {}) })).rejects.toThrow("timed out");
});
it("pins the actual socket without a second DNS lookup, preserves Host and does not follow redirects", async () => {
  let calls = 0, host: string | undefined;
  const server = createServer((req, res) => { calls++; host = req.headers.host; res.writeHead(302, { location: "http://other.invalid/" }); res.end("first response"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port, resolver = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const destination = await resolveNetworkDestination(`http://first.invalid:${port}/`, { authorize: grant, resolve: resolver, signal: signal() });
    const response = await requestPinnedHttp(destination, { method: "GET", headers: {}, maximumBytes: 5, signal: signal() });
    expect(response).toMatchObject({ status: 302, bodyTruncated: true }); expect(response.body.toString()).toBe("first");
    expect(resolver).toHaveBeenCalledOnce(); expect(host).toBe(`first.invalid:${port}`); expect(calls).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
