import { request } from "node:http";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openProcessNetworkEndpoint, type ProcessNetworkEndpoint, type ProcessNetworkPorts } from "./process-network-endpoint.js";

describe("per-execution process network endpoint", () => {
  const endpoints: ProcessNetworkEndpoint[] = [];
  afterEach(async () => { await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close())); });
  const http = vi.fn<ProcessNetworkPorts["http"]>(async () => ({ status: 200, headers: {}, body: Buffer.from("result") }));
  async function open(ports: Partial<ProcessNetworkPorts> = {}, bounds: Partial<Parameters<typeof openProcessNetworkEndpoint>[1]> = {}) {
    http.mockClear();
    const endpoint = await openProcessNetworkEndpoint({ http, assertCurrent() {}, ...ports }, {
      signal: new AbortController().signal, maximumRequests: 4, maximumBytes: 1024, timeoutMs: 5000, ...bounds,
    }); endpoints.push(endpoint); return endpoint;
  }
  function authorization(endpoint: ProcessNetworkEndpoint) { return `Basic ${Buffer.from(`${new URL(endpoint.proxyUrl).username}:`).toString("base64")}`; }
  function send(endpoint: ProcessNetworkEndpoint, auth = authorization(endpoint), body = "") {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: endpoint.port, method: "POST", path: "http://fixture.invalid/path",
        headers: { "proxy-authorization": auth, connection: "x-hidden", "x-hidden": "removed", "x-visible": "kept" } }, res => {
        let text = ""; res.on("data", bytes => text += bytes); res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      }); req.on("error", reject); req.end(body);
    });
  }
  it("forwards only through the host port and strips proxy and connection headers", async () => {
    const endpoint = await open();
    expect(await send(endpoint, undefined, "payload")).toEqual({ status: 200, body: "result" });
    expect(http.mock.calls[0]![0]).toMatchObject({ url: "http://fixture.invalid/path", method: "POST", headers: { "x-visible": "kept" }, body: Buffer.from("payload") });
    expect(http.mock.calls[0]![0].headers).not.toHaveProperty("proxy-authorization");
    expect(http.mock.calls[0]![0].headers).not.toHaveProperty("x-hidden");
    expect(http.mock.calls[0]![0].id).not.toContain(new URL(endpoint.proxyUrl).username);
  });
  it("does not dispatch invalid credentials or tokens from another execution", async () => {
    const first = await open(), second = await open();
    expect((await send(first, authorization(second))).status).toBe(407);
    expect(http).not.toHaveBeenCalled();
  });
  it("authenticates SOCKS5 TCP on the same sandbox port and routes through the host", async () => {
    const tunnel = vi.fn<NonNullable<ProcessNetworkPorts['tunnel']>>(async () => new PassThrough());
    const endpoint = await open({ tunnel });
    const token = Buffer.from(new URL(endpoint.socksUrl).username), host = Buffer.from('fixture.invalid');
    const socket = connect(endpoint.port, '127.0.0.1'); let output = Buffer.alloc(0);
    socket.on('data', bytes => output = Buffer.concat([output,bytes]));
    try {
      socket.write(Buffer.concat([Buffer.from([5,1,2,1,token.length]),token,Buffer.from([1,120,5,1,0,3,host.length]),host,Buffer.from([1,187]),Buffer.from('echo')]));
      await vi.waitFor(()=>expect(output.toString()).toContain('echo'));
      expect(tunnel).toHaveBeenCalledTimes(1);
      expect(tunnel.mock.calls[0]?.[0]).toMatchObject({hostname:'fixture.invalid',port:443,transport:'socks5'});
      expect(output.subarray(0,4)).toEqual(Buffer.from([5,2,1,0]));
      await endpoint.close(); await vi.waitFor(()=>expect(socket.destroyed).toBe(true));
    } finally { socket.destroy(); }
  });
  it("rejects SOCKS UDP and wrong credentials without dialing", async () => {
    const tunnel = vi.fn(async () => new PassThrough()), endpoint = await open({tunnel});
    for(const wrong of [true,false]) {
      const token=Buffer.from(wrong?'bad':new URL(endpoint.socksUrl).username), socket=connect(endpoint.port,'127.0.0.1');
      const closed=new Promise(resolve=>{socket.resume();socket.once('close',resolve);});
      socket.write(Buffer.concat([Buffer.from([5,1,2,1,token.length]),token,Buffer.from([1,120,5,3,0,1,127,0,0,1,0,80])]));
      await closed;
    }
    expect(tunnel).not.toHaveBeenCalled();
  });
  it("enforces request admission and does not return an over-budget response", async () => {
    const endpoint = await open({}, { maximumRequests: 1 });
    expect((await send(endpoint)).status).toBe(200);
    expect((await send(endpoint)).status).toBe(502); expect(http).toHaveBeenCalledTimes(1);
    const large = await open({ http: async () => ({ status: 200, headers: {}, body: Buffer.alloc(1025) }) });
    expect((await send(large)).status).toBe(502);
  });
  it("closes on revoked ownership and aborts an active host request", async () => {
    let valid = true; let started!: () => void;
    const running = new Promise<void>(resolve => started = resolve);
    let signal: AbortSignal | undefined;
    const endpoint = await open({ assertCurrent() { if (!valid) throw new Error("revoked"); }, http: async (_input, current) => {
      signal = current; started(); await new Promise<void>(resolve => current.addEventListener("abort", () => resolve(), { once: true }));
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    } });
    const pending = send(endpoint).catch(() => null); await running; valid = false;
    await pending; expect(signal?.aborted).toBe(true); expect(endpoint.signal.aborted).toBe(true);
    await endpoint.close(); await endpoint.close();
  });
  it("rejects tunnels unless a distinct host tunnel port is enabled", async () => {
    const endpoint = await open();
    const result = await tunnel(endpoint); expect(result).toContain("502"); expect(http).not.toHaveBeenCalled();
  });
  function tunnel(endpoint: ProcessNetworkEndpoint, suffix = "") {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(endpoint.port, "127.0.0.1", () => socket.write(`CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\nProxy-Authorization: ${authorization(endpoint)}\r\n\r\n${suffix}`));
      let text = ""; socket.on("data", bytes => { text += bytes; if (text.includes("200") && suffix) socket.destroy(); });
      socket.on("error", reject); socket.on("close", () => resolve(text));
    });
  }
  it("uses explicit tunnel authority and destroys streams on endpoint close", async () => {
    const stream = new PassThrough(); const openTunnel = vi.fn<NonNullable<ProcessNetworkPorts["tunnel"]>>(async () => stream);
    const endpoint = await open({ tunnel: openTunnel });
    expect(await tunnel(endpoint, "data")).toContain("200 Connection Established");
    expect(openTunnel.mock.calls[0]?.[0]).toMatchObject({ hostname: "fixture.invalid", port: 443 });
    await endpoint.close(); expect(stream.destroyed).toBe(true);
  });
  it("rejects invalid limits before opening a server", async () => {
    await expect(open({}, { maximumRequests: 0 })).rejects.toThrow("bounds");
  });
  it("checks ownership before opening and before each dispatch", async () => {
    let valid = false;
    const ports = { assertCurrent() { if (!valid) throw new Error("revoked"); } };
    await expect(open(ports)).rejects.toThrow("revoked");
    valid = true; const endpoint = await open(ports); valid = false;
    await send(endpoint).catch(() => null); expect(http).not.toHaveBeenCalled();
  });
  it("has a bounded lifetime even without a cooperative client", async () => {
    const endpoint = await open({}, { timeoutMs: 25 });
    await new Promise<void>(resolve => endpoint.signal.addEventListener("abort", () => resolve(), { once: true }));
    await endpoint.close(); expect(endpoint.signal.aborted).toBe(true);
  });
});
