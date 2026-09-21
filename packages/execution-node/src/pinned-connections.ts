import { request } from "node:http";
import { connect, type Socket } from "node:net";
import type { NetworkDestination } from "./network-destination.js";

function current(destination: NetworkDestination, signal: AbortSignal) {
  signal.throwIfAborted();
  if (Date.parse(destination.expiresAt) <= Date.now()) throw new Error("Destination expired before connect");
}
export async function connectPinnedTcp(destination: NetworkDestination, signal: AbortSignal): Promise<Socket> {
  current(destination, signal);
  const socket = connect({ host: destination.address, family: destination.family, port: destination.port });
  const abort = () => socket.destroy(new Error("Connection cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", abort));
  socket.setTimeout(30000, () => socket.destroy(new Error("Connection timeout")));
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.on("error", reject);
      socket.once("close", () => reject(new Error("Connection closed"))); });
    current(destination, signal); return socket;
  } catch (error) { socket.destroy(); throw error; }
}
export function upgradePinnedWebSocket(destination: NetworkDestination, headers: Record<string, string | string[]>, signal: AbortSignal) {
  current(destination, signal);
  if (new URL(destination.canonicalUrl).protocol !== "http:") throw new Error("Use an authorized TLS tunnel for secure WebSocket");
  return new Promise<{ stream: Socket; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(destination.canonicalUrl, { method: "GET", headers: { ...headers, connection: "Upgrade", upgrade: "websocket" },
      signal, agent: false, family: destination.family,
      lookup: (_host, _options, callback) => callback(null, destination.address, destination.family) });
    req.once("upgrade", (response, stream, head) => { stream.pause(); if (head.length) stream.unshift(head);
      resolve({ stream, headers: response.headers }); });
    req.once("response", response => { response.destroy(); reject(new Error("WebSocket upgrade rejected")); });
    req.once("error", reject); req.setTimeout(30000, () => req.destroy(new Error("Upgrade timeout"))); req.end();
  });
}
