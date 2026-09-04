import {
  createPrivateKey,
  createPublicKey,
  createHash,
  sign,
  verify,
} from "node:crypto";
import {
  browserRuntimeSourceLockSha256,
  parseBrowserRuntimeSourceLock,
  type BrowserRuntimeSourceLock,
} from "./browser-runtime-source-lock.js";

export const BROWSER_RUNTIME_SOURCE_REVIEW_PROFILE = "traceforge-browser-runtime-source-review-v1" as const;
export const BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE = "traceforge-browser-runtime-source-authority-v1" as const;

export interface BrowserRuntimeSourceReview {
  format: 1;
  profile: typeof BROWSER_RUNTIME_SOURCE_REVIEW_PROFILE;
  keyId: string;
  lockSha256: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export interface BrowserRuntimeSourceAuthority {
  format: 1;
  profile: typeof BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE;
  keyId: string;
  publicKeyPem: string;
  sourceIds: string[];
  validFrom: string;
  validUntil: string;
  revokedAt: string | null;
}

export interface VerifiedBrowserRuntimeSourceReview {
  lock: BrowserRuntimeSourceLock;
  review: BrowserRuntimeSourceReview;
  authority: BrowserRuntimeSourceAuthority;
  lockSha256: string;
  reviewSha256: string;
}

const reviewKeys = ["expiresAt", "format", "issuedAt", "keyId", "lockSha256", "profile", "signature"];
const authorityKeys = ["format", "keyId", "profile", "publicKeyPem", "revokedAt", "sourceIds", "validFrom", "validUntil"];

export function browserRuntimeSourceReviewSigningPayload(
  value: Omit<BrowserRuntimeSourceReview, "signature">,
): string {
  const review = parseReview({ ...value, signature: Buffer.alloc(64).toString("base64") });
  const { signature: _signature, ...payload } = review;
  return canonicalJson(payload);
}

export function createBrowserRuntimeSourceReview(input: {
  sourceLock: unknown;
  keyId: string;
  privateKeyPem: string;
  issuedAt: string;
  expiresAt: string;
}): BrowserRuntimeSourceReview {
  const lock = parseBrowserRuntimeSourceLock(input.sourceLock);
  const keyId = identity(input.keyId, "review key identity", 128);
  const issuedAt = timestamp(input.issuedAt, "review issued timestamp");
  const expiresAt = timestamp(input.expiresAt, "review expiry timestamp");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(lock.createdAt) > Date.parse(issuedAt)) {
    throw new Error("Browser Runtime source review time window is invalid");
  }
  const payload = {
    format: 1 as const,
    profile: BROWSER_RUNTIME_SOURCE_REVIEW_PROFILE,
    keyId,
    lockSha256: browserRuntimeSourceLockSha256(lock),
    issuedAt,
    expiresAt,
  };
  if (!input.privateKeyPem.trim() || Buffer.byteLength(input.privateKeyPem) > 16 * 1024) {
    throw new Error("Browser Runtime source review private key is invalid");
  }
  let key;
  try { key = createPrivateKey(input.privateKeyPem); }
  catch { throw new Error("Browser Runtime source review private key is invalid"); }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Browser Runtime source review requires an Ed25519 private key");
  }
  return parseReview({
    ...payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), key).toString("base64"),
  });
}

export function parseBrowserRuntimeSourceAuthority(value: unknown): BrowserRuntimeSourceAuthority {
  const authority = exactRecord(value, authorityKeys, "Browser Runtime source authority");
  if (authority.format !== 1 || authority.profile !== BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE) {
    throw new Error("Browser Runtime source authority profile is incompatible");
  }
  const keyId = identity(authority.keyId, "authority key identity", 128);
  if (typeof authority.publicKeyPem !== "string" || !authority.publicKeyPem.trim()
    || Buffer.byteLength(authority.publicKeyPem) > 16 * 1024) {
    throw new Error("Browser Runtime source authority public key is invalid");
  }
  if (!Array.isArray(authority.sourceIds) || authority.sourceIds.length < 1 || authority.sourceIds.length > 64) {
    throw new Error("Browser Runtime source authority scope is invalid");
  }
  const sourceIds = authority.sourceIds.map((sourceId) => identity(sourceId, "authority source identity", 128));
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error("Browser Runtime source authority scope is duplicated");
  const validFrom = timestamp(authority.validFrom, "authority start timestamp");
  const validUntil = timestamp(authority.validUntil, "authority expiry timestamp");
  if (Date.parse(validUntil) <= Date.parse(validFrom)) throw new Error("Browser Runtime source authority time window is invalid");
  const revokedAt = authority.revokedAt === null ? null : timestamp(authority.revokedAt, "authority revocation timestamp");
  if (revokedAt !== null && Date.parse(revokedAt) < Date.parse(validFrom)) {
    throw new Error("Browser Runtime source authority revocation timestamp is invalid");
  }
  let key;
  try { key = createPublicKey(authority.publicKeyPem); }
  catch { throw new Error("Browser Runtime source authority public key is invalid"); }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Browser Runtime source authority requires an Ed25519 public key");
  }
  return structuredClone({ ...authority, keyId, sourceIds, validFrom, validUntil, revokedAt }) as BrowserRuntimeSourceAuthority;
}

export function verifyBrowserRuntimeSourceReview(input: {
  sourceLock: unknown;
  sourceReview: unknown;
  authority: unknown;
  now?: string;
}): VerifiedBrowserRuntimeSourceReview {
  const lock = parseBrowserRuntimeSourceLock(input.sourceLock);
  const review = parseReview(input.sourceReview);
  const authority = parseBrowserRuntimeSourceAuthority(input.authority);
  const now = timestamp(input.now ?? new Date().toISOString(), "verification timestamp");
  const current = Date.parse(now), issued = Date.parse(review.issuedAt), expires = Date.parse(review.expiresAt);
  const validFrom = Date.parse(authority.validFrom), validUntil = Date.parse(authority.validUntil);
  const lockSha256 = browserRuntimeSourceLockSha256(lock);
  if (review.keyId !== authority.keyId || review.lockSha256 !== lockSha256
    || !authority.sourceIds.includes(lock.sourceId)) {
    throw new Error("Browser Runtime source review identity or scope does not match its authority");
  }
  if (issued < validFrom || issued >= validUntil || expires > validUntil
    || Date.parse(lock.createdAt) > issued || current < issued || current >= expires
    || current < validFrom || current >= validUntil
    || (authority.revokedAt !== null && current >= Date.parse(authority.revokedAt))) {
    throw new Error("Browser Runtime source review or authority is not currently valid");
  }
  const signature = canonicalBase64(review.signature, "source review signature");
  const { signature: _signature, ...payload } = review;
  const key = createPublicKey(authority.publicKeyPem);
  if (signature.length !== 64 || !verify(null, Buffer.from(canonicalJson(payload)), key, signature)) {
    throw new Error("Browser Runtime source review signature verification failed");
  }
  return {
    lock,
    review,
    authority,
    lockSha256,
    reviewSha256: createHash("sha256").update(canonicalJson(review)).digest("hex"),
  };
}

function parseReview(value: unknown): BrowserRuntimeSourceReview {
  const review = exactRecord(value, reviewKeys, "Browser Runtime source review");
  if (review.format !== 1 || review.profile !== BROWSER_RUNTIME_SOURCE_REVIEW_PROFILE) {
    throw new Error("Browser Runtime source review profile is incompatible");
  }
  const keyId = identity(review.keyId, "review key identity", 128);
  if (typeof review.lockSha256 !== "string" || !/^[a-f0-9]{64}$/.test(review.lockSha256)) {
    throw new Error("Browser Runtime source review lock digest is invalid");
  }
  const issuedAt = timestamp(review.issuedAt, "review issued timestamp");
  const expiresAt = timestamp(review.expiresAt, "review expiry timestamp");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error("Browser Runtime source review time window is invalid");
  canonicalBase64(review.signature, "source review signature");
  return structuredClone({ ...review, keyId, issuedAt, expiresAt }) as BrowserRuntimeSourceReview;
}

function canonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    || Buffer.byteLength(value) > 128) throw new Error(`Browser Runtime ${label} is invalid`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`Browser Runtime ${label} is invalid`);
  return bytes;
}

function identity(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximumBytes
    || /[\0\r\n]/.test(value)) throw new Error(`Browser Runtime ${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new Error(`Browser Runtime ${label} is invalid`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)) {
    throw new Error(`${label} has missing or unknown fields`);
  }
  return record;
}
