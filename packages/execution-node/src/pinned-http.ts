import { request as http } from "node:http";
import { request as https } from "node:https";
import type { NetworkDestination } from "./network-destination.js";

/** Shared transport: no ambient proxy, pooled socket, DNS re-resolution or
 * redirect following. The caller authorizes every subsequent redirect itself. */
export function requestPinnedHttp(destination: NetworkDestination, input: {
  method: string; headers: Record<string, string | string[]>; body?: Buffer; maximumBytes: number; signal: AbortSignal;
  stopAfterChunk?: (body: Buffer, headers: import("node:http").IncomingHttpHeaders) => boolean;
}): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer; bodyTruncated: boolean }> {
  if (!(Date.parse(destination.expiresAt) > Date.now())) return Promise.reject(new Error("Destination expired before connect"));
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) return Promise.reject(new Error("Invalid HTTP response byte limit"));
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const url = new URL(destination.canonicalUrl);
    const req = (url.protocol === "https:" ? https : http)(url, {
      method: input.method, headers: input.headers, signal: input.signal, agent: false, family: destination.family,
      lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family),
    }, res => {
      const chunks: Buffer[] = []; let size = 0, done = false;
      const finish = (bodyTruncated: boolean) => { if (done) return; done = true;
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks, size), bodyTruncated }); };
      res.on("error", error => { if (!done) reject(error); });
      res.on("aborted", () => { if (!done) reject(new Error("Pinned HTTP response interrupted")); });
      res.on("data", (chunk: Buffer) => {
        const remaining = input.maximumBytes - size, kept = chunk.subarray(0, Math.max(0, remaining));
        chunks.push(kept); size += kept.length;
        if (chunk.length > remaining) { finish(true); res.destroy(); }
        else { try { if (input.stopAfterChunk?.(Buffer.concat(chunks, size), res.headers)) { finish(false); res.destroy(); } }
          catch (error) { reject(error); done = true; res.destroy(); } }
      });
      res.on("end", () => finish(false));
    });
    req.on("error", reject); req.end(input.body);
  });
}
