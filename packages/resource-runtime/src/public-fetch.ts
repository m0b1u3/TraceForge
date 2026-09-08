import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export interface PublicResponse { url: string; status: number; contentType: string; bytes: Buffer }
export type PublicFetch = (url: string, options?: { maximumBytes?: number; headers?: Record<string, string>; signal?: AbortSignal; authorizeUrl?: (url: string) => void }) => Promise<PublicResponse>;

export function publicUrl(value: string): URL {
  if (value.length > 4096) throw new Error("Public URL is too long");
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash || !url.hostname.includes(".")) throw new Error("Use a public HTTPS URL without credentials or fragments");
  return url;
}
/** Fail closed on non-global, mapped, multicast and transition address ranges. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes(".")) return false;
  const [first, second = 0] = address.split(":").map(part => Number.parseInt(part || "0", 16));
  return first >= 0x2000 && first < 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

/** Resolves and pins the address used by the socket on EVERY hop. No ambient proxy,
 * cookies, system credentials or inherited headers; redirect credentials are stripped. */
export const fetchPublic: PublicFetch = async (value, options = {}) => {
  const maximumBytes = options.maximumBytes ?? 1024 * 1024;
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8 * 1024 * 1024) throw new Error("Invalid download limit");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  let url = publicUrl(value), headers = options.headers ?? {};
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal.throwIfAborted();
    options.authorizeUrl?.(url.href);
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      const abort = () => reject(new Error("Public resource DNS lookup timed out or was cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      lookup(url.hostname, { all: true, verbatim: true }).then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
    signal.throwIfAborted();
    options.authorizeUrl?.(url.href);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("Public resource resolved to a non-public address");
    const address = addresses[0];
    const response = await new Promise<{ status: number; location?: string; contentType: string; bytes: Buffer }>((resolve, reject) => {
      const req = request(url, { method: "GET", signal, agent: false,
        headers: { "user-agent": "TraceForge-ResourceReader/1", "accept-encoding": "identity", ...headers },
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family) }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maximumBytes) res.destroy(new Error("Public resource exceeds download limit")); else chunks.push(chunk); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, contentType: String(res.headers["content-type"] ?? ""), bytes: Buffer.concat(chunks) }));
      });
      req.on("error", () => reject(new Error("Public resource request failed or timed out"))); req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || redirect === 3) throw new Error("Public resource redirect limit exceeded");
      const next = publicUrl(new URL(response.location, url).href);
      if (next.origin !== url.origin) headers = {};
      url = next; continue;
    }
    return { url: url.href, status: response.status, contentType: response.contentType, bytes: response.bytes };
  }
  throw new Error("Public resource unavailable");
};
