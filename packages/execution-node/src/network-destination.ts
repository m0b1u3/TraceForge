import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface DestinationAuthorization { authorizationRef: string; canonicalUrl: string; expiresAt: string }
export interface NetworkDestination extends DestinationAuthorization {
  hostname: string; address: string; family: 4 | 6; port: number;
  addressAuthorizationRefs: string[];
}
export type DestinationResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/** Non-global addresses are not forbidden targets: they require explicit Scope
 * authorization of the literal destination, independent of a DNS name grant. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes(".")) return false;
  const [first, second = 0] = address.split(":").map(part => Number.parseInt(part || "0", 16));
  return first >= 0x2000 && first < 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

/** One bounded resolution, all returned A/AAAA checked, one address pinned.
 * TLS/Host retain the logical host. No DNS result is interpreted as consent. */
export async function resolveNetworkDestination(value: string, options: {
  authorize(url: string): DestinationAuthorization | Promise<DestinationAuthorization>;
  signal: AbortSignal; publicOnly?: boolean; allowedAddresses?: readonly string[]; resolve?: DestinationResolver; now?: () => number;
}): Promise<NetworkDestination> {
  const url = new URL(value), now = options.now ?? Date.now;
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsupported network destination");
  const hostname = url.hostname.replace(/^\[|\]$/g, ""), port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const authorize = async (target: string) => {
    options.signal.throwIfAborted();
    const grant = await options.authorize(target);
    options.signal.throwIfAborted();
    if (grant.canonicalUrl !== target || !grant.authorizationRef || !(Date.parse(grant.expiresAt) > now())) throw new Error("Network destination grant invalid or expired");
    return grant;
  };
  await authorize(url.href);
  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const abort = () => reject(new Error("Network destination lookup cancelled or timed out"));
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) { options.signal.removeEventListener("abort", abort); abort(); return; }
    const pending = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
      : (options.resolve ?? (host => lookup(host, { all: true, verbatim: true })))(hostname);
    pending.then(resolve, reject).finally(() => options.signal.removeEventListener("abort", abort));
  });
  if (!addresses.length || addresses.length > 64) throw new Error("Invalid destination address set");
  let grant = await authorize(url.href), expiry = Date.parse(grant.expiresAt);
  const addressAuthorizationRefs: string[] = [];
  for (const item of addresses) {
    if (![4, 6].includes(item.family) || isIP(item.address) !== item.family) throw new Error("Invalid resolved address");
    const normalize = (address: string) => new URL(`http://${isIP(address) === 6 ? `[${address}]` : address}/`).hostname;
    if (options.allowedAddresses?.length && !options.allowedAddresses.some(address => isIP(address) && normalize(address) === normalize(item.address)))
      throw new Error("Resolved destination is outside the configured address binding");
    if (!isPublicAddress(item.address)) {
      if (options.publicOnly) throw new Error("Public resource resolved to a non-public address");
      const literal = new URL(url); literal.hostname = item.family === 6 ? `[${item.address}]` : item.address;
      const addressGrant = await authorize(literal.href);
      addressAuthorizationRefs.push(addressGrant.authorizationRef);
      expiry = Math.min(expiry, Date.parse(addressGrant.expiresAt));
    }
  }
  // Authorization may have been revoked while an address policy was evaluated.
  grant = await authorize(url.href); expiry = Math.min(expiry, Date.parse(grant.expiresAt));
  if (expiry <= now()) throw new Error("Network destination grant expired");
  return { ...grant, expiresAt: new Date(expiry).toISOString(), hostname, port, addressAuthorizationRefs,
    address: addresses[0]!.address, family: addresses[0]!.family as 4 | 6 };
}
