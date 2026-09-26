import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createServer as createTcpServer } from "node:net";
import { serveProcessSocks } from "./process-socks-proxy.js";

export interface ProcessNetworkPorts {
  /** Must check the current execution, lease and concrete destination grant.
   * Persist admission before dispatch and store the actual result/unknown receipt.
   * HTTP and opaque TLS tunnels are different grants and receipt contracts. */
  http(input: { id: string; url: string; method: string; headers: Record<string, string | string[]>; body: Buffer }, signal: AbortSignal): Promise<{
    status: number; headers: Record<string, string | string[]>; body: Buffer;
  }>;
  /** Optional. Absence rejects CONNECT; never substitute broad direct networking.
   * Authorize host/port (not TLS paths), pin the destination and journal the
   * connection before opening it. The returned stream belongs to this execution. */
  tunnel?: (input: { id: string; hostname: string; port: number; transport?: "socks5" }, signal: AbortSignal) => Promise<Duplex>;
  websocket?: (input: { id: string; url: string; headers: Record<string, string | string[]> }, signal: AbortSignal) => Promise<{ stream: Duplex; headers: Record<string, string | string[]> }>;
  assertCurrent(): void;
}
export interface ProcessNetworkEndpoint {
  port: number;
  /** Ephemeral execution token; do not persist in configuration or receipts. */
  proxyUrl: string;
  socksUrl: string;
  signal: AbortSignal;
  close(): Promise<void>;
}

/** A per-execution transport adapter, not an authorization service. All outbound
 * effects go through explicit host ports; this module has no direct dial/fetch
 * fallback. It is deliberately not registered as a model/Scenario capability. */
export async function openProcessNetworkEndpoint(ports: ProcessNetworkPorts, options: {
  signal: AbortSignal; maximumRequests: number; maximumBytes: number; maximumStreamBytes?: number; timeoutMs: number;
}): Promise<ProcessNetworkEndpoint> {
  for (const [value, upper] of [[options.maximumRequests, Number.MAX_SAFE_INTEGER], [options.maximumBytes, 64 * 1024 * 1024],
    [options.maximumStreamBytes??options.maximumBytes, Number.MAX_SAFE_INTEGER], [options.timeoutMs, 2147483647]])
    if (!Number.isSafeInteger(value) || value! < 1 || value! > upper!) throw new Error("Invalid process network bounds");
  options.signal.throwIfAborted(); ports.assertCurrent();
  const token = randomBytes(32).toString("hex"), expected = Buffer.from(`Basic ${Buffer.from(`${token}:`).toString("base64")}`);
  const epoch = randomUUID(), abort = new AbortController(), streams = new Set<Duplex>();
  let count = 0, closed = false, closing: Promise<void> | undefined;
  const server = createServer();
  server.maxConnections = 32;
  server.maxHeadersCount = 64; server.headersTimeout = Math.min(options.timeoutMs, 10000);
  server.requestTimeout = options.timeoutMs;
  const current = () => { abort.signal.throwIfAborted(); options.signal.throwIfAborted(); ports.assertCurrent(); };
  const credentials = (request: IncomingMessage) => {
    const value = request.headers["proxy-authorization"];
    const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.alloc(0);
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  };
  const admit = () => { current(); if (++count > options.maximumRequests) throw new Error("Process network request budget exceeded"); return `process-network:${epoch}:${count}`; };
  const own = (stream: Duplex) => { streams.add(stream); stream.on("error", () => undefined); stream.once("close", () => streams.delete(stream)); return stream; };
  server.on("connection", own);
  server.on("clientError", (_error, socket) => socket.destroy());
  const fail = (response: ServerResponse, status: number) => {
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { "content-type": "text/plain", ...(status === 407 ? { "proxy-authenticate": "Basic realm=TraceForge" } : {}) });
    response.end("Process network request unavailable");
  };
  server.on("request", async (request, response) => {
    if (!credentials(request)) { fail(response, 407); request.resume(); return; }
    const operation = new AbortController();
    response.once("close", () => { if (!response.writableFinished) operation.abort(); });
    try {
      const id = admit(), url = new URL(request.url ?? "");
      if (url.protocol !== "http:" || url.username || url.password || url.hash) throw new Error("Invalid proxy URL");
      const body: Buffer[] = []; let size = 0;
      for await (const bytes of request) {
        current(); size += bytes.length;
        if (size > options.maximumBytes) throw new Error("Process network body exceeds budget");
        body.push(Buffer.from(bytes));
      }
      current();
      const result = await ports.http({ id, url: url.href, method: request.method ?? "GET", headers: cleanHeaders(request.headers), body: Buffer.concat(body) },
        AbortSignal.any([abort.signal, operation.signal]));
      current(); operation.signal.throwIfAborted();
      if (!Number.isSafeInteger(result.status) || result.status < 200 || result.status > 599 || !Buffer.isBuffer(result.body) || result.body.length > options.maximumBytes)
        throw new Error("Invalid broker response");
      response.writeHead(result.status, { ...cleanHeaders(result.headers), "content-length": result.body.length }); response.end(result.body);
    } catch { fail(response, 502); }
  });
  server.on("connect", async (request, socket, head) => {
    if (!credentials(request)) { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=TraceForge\r\nConnection: close\r\n\r\n"); return; }
    let upstream: Duplex | undefined;
    const operation = new AbortController();
    socket.once("close", () => { operation.abort(); upstream?.destroy(); });
    try {
      const id = admit();
      if (!ports.tunnel) throw new Error("Opaque tunnels are not enabled");
      const authority = request.url ?? "", url = new URL(`https://${authority}`);
      if (!authority || /[\s/@?#]/.test(authority) || url.username || url.password) throw new Error("Invalid tunnel authority");
      const port = Number(url.port || 443);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid tunnel port");
      upstream = own(await ports.tunnel({ id, hostname: url.hostname, port }, AbortSignal.any([abort.signal, operation.signal])));
      current(); operation.signal.throwIfAborted();
      let bytes = head.length;
      if (bytes > (options.maximumStreamBytes??options.maximumBytes)) throw new Error("Tunnel exceeds byte budget");
      const meter = (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maximumStreamBytes??options.maximumBytes)) { upstream?.destroy(); socket.destroy(); } };
      socket.on("data", meter); upstream.on("data", meter);
      upstream.once("close", () => socket.destroy());
      upstream.once("error", () => socket.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
    } catch { upstream?.destroy(); if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); }
  });
  server.on("upgrade", async (request, socket, head) => {
    if (!credentials(request)) { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n"); return; }
    let upstream: Duplex | undefined;
    const operation = new AbortController(); socket.once("close", () => { operation.abort(); upstream?.destroy(); });
    try {
      const id = admit(), url = new URL(request.url ?? "");
      if (url.protocol === "ws:") url.protocol = "http:";
      if (!ports.websocket || url.protocol !== "http:" || url.username || url.password || url.hash || request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") throw new Error("WebSocket upgrade unavailable");
      const result = await ports.websocket({ id, url: url.href, headers: cleanHeaders(request.headers) }, AbortSignal.any([abort.signal, operation.signal]));
      upstream = own(result.stream); current(); operation.signal.throwIfAborted();
      let bytes = head.length;
      if (bytes > (options.maximumStreamBytes??options.maximumBytes)) throw new Error("WebSocket exceeds byte budget");
      const headers = cleanHeaders(result.headers);
      // Only handshake headers, never upstream cookies or unrelated response data.
      const lines = Object.entries(headers).filter(([name]) => ['sec-websocket-accept','sec-websocket-protocol','sec-websocket-extensions'].includes(name.toLowerCase()))
        .map(([name,value]) => { if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid upgrade header'); return `${name}: ${value}`; });
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${lines.join('\r\n')}\r\n\r\n`);
      const meter = (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maximumStreamBytes??options.maximumBytes)) { upstream?.destroy(); socket.destroy(); } };
      socket.on('data',meter); upstream.on('data',meter);
      upstream.once('close',()=>socket.destroy()); upstream.once('error',()=>socket.destroy());
      upstream.pipe(socket); if (head.length) upstream.write(head); socket.pipe(upstream);
    } catch { upstream?.destroy(); if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); }
  });
  // One exclusive port in the OS sandbox for both HTTP and SOCKS clients.
  const listener = createTcpServer(socket => {
    own(socket); socket.setTimeout(10000, () => socket.destroy());
    socket.once("data", first => {
      socket.setTimeout(0); socket.pause();
      if (first[0] === 5) {
        const operation = new AbortController(); socket.once("close", () => operation.abort());
        void serveProcessSocks(socket, token, async (hostname, port) => {
          const id = admit(); if (!ports.tunnel) throw new Error("Tunnels unavailable");
          const upstream = await ports.tunnel({ id, hostname, port, transport: "socks5" }, AbortSignal.any([abort.signal, operation.signal]));
          try { current(); operation.signal.throwIfAborted(); return upstream; } catch (error) { upstream.destroy(); throw error; }
        }, options.maximumStreamBytes??options.maximumBytes, own);
        socket.unshift(first); socket.resume();
      } else { socket.unshift(first); server.emit("connection", socket); socket.resume(); }
    });
  });
  listener.maxConnections = 32;
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", () => { listener.off("error", reject); resolve(); }); });
  // Bound lifetime is also a deadline for uncooperative clients and port callbacks.
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true; abort.abort(); clearInterval(poll); clearTimeout(deadline); options.signal.removeEventListener("abort", cancel);
    for (const stream of streams) stream.destroy();
    closing = new Promise<void>(resolve => listener.close(() => resolve())); return closing;
  };
  const cancel = () => { void close(); };
  const poll = setInterval(() => { try { current(); } catch { cancel(); } }, 100);
  const deadline = setTimeout(cancel, options.timeoutMs);
  options.signal.addEventListener("abort", cancel, { once: true });
  try { current(); } catch (error) { await close(); throw error; }
  const address = listener.address();
  if (closed || !address || typeof address === "string") { await close(); throw new Error("Process endpoint unavailable"); }
  return { port: address.port, proxyUrl: `http://${token}:@127.0.0.1:${address.port}`, socksUrl: `socks5h://${token}:x@127.0.0.1:${address.port}`, signal: abort.signal, close };
}

function cleanHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const denied = new Set(["connection", "proxy-authorization", "proxy-authenticate", "proxy-connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length"]);
  for (const name of String(headers.connection ?? "").split(",")) denied.add(name.trim().toLowerCase());
  const result: Record<string, string | string[]> = Object.create(null);
  for (const [name, value] of Object.entries(headers)) if (!denied.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  return result;
}
