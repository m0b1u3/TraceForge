import { resolveNetworkDestination, requestPinnedHttp } from "@traceforge/execution-node";
export { isPublicAddress } from "@traceforge/execution-node";

export interface PublicResponse { url: string; status: number; contentType: string; bytes: Buffer }
export type PublicFetch = (url: string, options?: { maximumBytes?: number; headers?: Record<string, string>; signal?: AbortSignal; authorizeUrl?: (url: string) => void }) => Promise<PublicResponse>;

export function publicUrl(value: string): URL {
  if (value.length > 4096) throw new Error("Public URL is too long");
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash || !url.hostname.includes(".")) throw new Error("Use a public HTTPS URL without credentials or fragments");
  return url;
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
    const destination = await resolveNetworkDestination(url.href, { signal, publicOnly: true, authorize: target => {
      options.authorizeUrl?.(target);
      return { authorizationRef: "public-resource", canonicalUrl: publicUrl(target).href, expiresAt: new Date(Date.now() + 20000).toISOString() };
    } });
    const result = await requestPinnedHttp(destination, { method: "GET", signal, maximumBytes,
      headers: { "user-agent": "TraceForge-ResourceReader/1", "accept-encoding": "identity", ...headers } });
    if (result.bodyTruncated) throw new Error("Public resource exceeds download limit");
    const response = { status: result.status, location: result.headers.location, contentType: String(result.headers["content-type"] ?? ""), bytes: result.body };
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
