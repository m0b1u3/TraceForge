import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE,
  BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  createBrowserRuntimeSourceReview,
  verifyBrowserRuntimeSourceReview,
  type BrowserRuntimeSourceAuthority,
  type BrowserRuntimeSourceLock,
} from "./index.js";

const keys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const lock: BrowserRuntimeSourceLock = {
  format: 1,
  profile: BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  sourceId: "traceforge-reviewed-chromium-build",
  version: "140.0.0.0",
  revision: "0123456789abcdef",
  createdAt: "2026-09-04T00:00:00.000Z",
  buildAttestationSha256: "b".repeat(64),
  securityReviewRef: "security-review/chromium/140",
  licenseReviewRef: "license-review/chromium/140",
  targets: [{ platform: "linux", architecture: "x64", archiveFormat: "zip",
    url: "https://downloads.example.invalid/chromium.zip", archiveBytes: 1024,
    archiveSha256: "a".repeat(64), rootDirectory: "chromium", executable: "chrome" }],
};
const authority: BrowserRuntimeSourceAuthority = {
  format: 1,
  profile: BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE,
  keyId: "browser-release-reviewer-1",
  publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  sourceIds: [lock.sourceId],
  validFrom: "2026-09-01T00:00:00.000Z",
  validUntil: "2027-01-01T00:00:00.000Z",
  revokedAt: null,
};
const review = createBrowserRuntimeSourceReview({
  sourceLock: lock,
  keyId: authority.keyId,
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  issuedAt: "2026-09-04T00:01:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z",
});

describe("Browser Runtime source review", () => {
  it("requires an Ed25519 review from a current authority scoped to the exact source lock", () => {
    expect(verifyBrowserRuntimeSourceReview({
      sourceLock: lock,
      sourceReview: review,
      authority,
      now: "2026-09-04T00:02:00.000Z",
    })).toMatchObject({ lock, review, authority, lockSha256: review.lockSha256 });
    expect(() => verifyBrowserRuntimeSourceReview({
      sourceLock: { ...lock, revision: "changed" }, sourceReview: review, authority,
      now: "2026-09-04T00:02:00.000Z",
    })).toThrow("identity or scope");
    expect(() => verifyBrowserRuntimeSourceReview({
      sourceLock: lock, sourceReview: review, authority: { ...authority, sourceIds: ["another-source"] },
      now: "2026-09-04T00:02:00.000Z",
    })).toThrow("identity or scope");
  });

  it("fails closed for expired, future, revoked, non-canonical or incorrectly signed reviews", () => {
    expect(() => verifyBrowserRuntimeSourceReview({
      sourceLock: lock, sourceReview: review, authority, now: review.expiresAt,
    })).toThrow("not currently valid");
    expect(() => verifyBrowserRuntimeSourceReview({
      sourceLock: lock, sourceReview: review,
      authority: { ...authority, revokedAt: "2026-09-04T00:01:30.000Z" },
      now: "2026-09-04T00:02:00.000Z",
    })).toThrow("not currently valid");
    expect(() => verifyBrowserRuntimeSourceReview({
      sourceLock: lock, sourceReview: review,
      authority: { ...authority, publicKeyPem: otherKeys.publicKey.export({ type: "spki", format: "pem" }).toString() },
      now: "2026-09-04T00:02:00.000Z",
    })).toThrow("signature verification failed");
    expect(() => verifyBrowserRuntimeSourceReview({
      sourceLock: lock, sourceReview: { ...review, signature: review.signature.replace(/=+$/, "") }, authority,
      now: "2026-09-04T00:02:00.000Z",
    })).toThrow("signature");
  });
});
