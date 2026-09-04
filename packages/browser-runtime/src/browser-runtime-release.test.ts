import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_RUNTIME_CONTROLLER_PROTOCOL,
  BROWSER_RUNTIME_RELEASE_PROFILE,
  browserRuntimeMaterialSha256,
  createBrowserRuntimeReleaseManifest,
  parseBrowserRuntimeReleaseManifest,
  verifyInstalledBrowserRuntimeRelease,
} from "./browser-runtime-release.js";
import { BROWSER_RUNTIME_SOURCE_LOCK_PROFILE, browserRuntimeSourceLockSha256,
  type BrowserRuntimeSourceLock } from "./browser-runtime-source-lock.js";
import { BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE, createBrowserRuntimeSourceReview,
  verifyBrowserRuntimeSourceReview } from "./browser-runtime-source-review.js";
import { browserRuntimeBuildAttestationSha256 } from "./browser-runtime-build-attestation.js";
import { createTestBrowserRuntimeBuildAttestation } from "./test-fixtures/browser-runtime-material.js";

const controllerBytes = Buffer.from("reviewed-browser-controller");
const browserBytes = Buffer.from("reviewed-chromium-binary");
const sourceTarget = { platform: "linux" as const, architecture: "x64" as const, archiveFormat: "zip" as const,
  url: "https://downloads.example.invalid/browser.zip", archiveBytes: 1024,
  archiveSha256: "a".repeat(64), rootDirectory: "chromium", executable: "chrome" };
const buildAttestation = createTestBrowserRuntimeBuildAttestation({
  version: "HeadlessChrome/140.0.0.0", revision: "1".repeat(40), target: sourceTarget,
  browserTreeSha256: "c".repeat(64),
});
const sourceLock: BrowserRuntimeSourceLock = {
  format: 1,
  profile: BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  sourceId: "reviewed-browser-distribution",
  version: "HeadlessChrome/140.0.0.0",
  revision: "1".repeat(40),
  createdAt: "2026-09-04T00:00:00.000Z",
  buildAttestationSha256: browserRuntimeBuildAttestationSha256(buildAttestation),
  securityReviewRef: `sha256:${buildAttestation.compliance.securityAssessmentSha256}`,
  licenseReviewRef: `sha256:${buildAttestation.compliance.licenseReviewSha256}`,
  targets: [sourceTarget],
};
const keys = generateKeyPairSync("ed25519");
const sourceAuthority = {
  format: 1 as const, profile: BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE, keyId: "browser-release-reviewer",
  publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  sourceIds: [sourceLock.sourceId], validFrom: "2026-09-01T00:00:00.000Z",
  validUntil: "2099-01-01T00:00:00.000Z", revokedAt: null,
};
const sourceReview = createBrowserRuntimeSourceReview({ sourceLock, keyId: sourceAuthority.keyId,
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  issuedAt: "2026-09-04T00:01:00.000Z", expiresAt: "2098-01-01T00:00:00.000Z" });
const verifiedReview = verifyBrowserRuntimeSourceReview({ sourceLock, sourceReview, authority: sourceAuthority,
  now: "2026-09-04T00:02:00.000Z" });
const source = {
  lockSha256: browserRuntimeSourceLockSha256(sourceLock),
  sourceId: sourceLock.sourceId,
  version: sourceLock.version,
  revision: sourceLock.revision,
  archiveBytes: sourceLock.targets[0]!.archiveBytes,
  archiveSha256: sourceLock.targets[0]!.archiveSha256,
  securityReviewRef: sourceLock.securityReviewRef,
  licenseReviewRef: sourceLock.licenseReviewRef,
  reviewKeyId: sourceReview.keyId,
  reviewSha256: verifiedReview.reviewSha256,
  reviewExpiresAt: sourceReview.expiresAt,
  buildAttestationSha256: sourceLock.buildAttestationSha256,
};
const manifest = createBrowserRuntimeReleaseManifest({
  platform: "linux",
  architecture: "x64",
  source,
  controller: { executable: "traceforge-browser-controller", version: "1.0.0", bytes: controllerBytes },
  browser: { root: "chromium", executable: "chrome", version: "HeadlessChrome/140.0.0.0",
    executableSha256: browserRuntimeMaterialSha256(browserBytes),
    tree: { sha256: "c".repeat(64), entries: 1, bytes: browserBytes.length } },
});

describe("Browser Runtime release material", () => {
  it("creates a strict manifest tied to both controller and browser bytes", () => {
    expect(manifest).toEqual({
      format: 3,
      profile: BROWSER_RUNTIME_RELEASE_PROFILE,
      protocol: BROWSER_RUNTIME_CONTROLLER_PROTOCOL,
      platform: "linux",
      architecture: "x64",
      source,
      controller: {
        executable: "traceforge-browser-controller",
        version: "1.0.0",
        sha256: browserRuntimeMaterialSha256(controllerBytes),
      },
      browser: {
        root: "chromium",
        executable: "chrome",
        version: "HeadlessChrome/140.0.0.0",
        executableSha256: browserRuntimeMaterialSha256(browserBytes),
        tree: { sha256: "c".repeat(64), entries: 1, bytes: browserBytes.length },
      },
    });
  });

  it("rejects unknown fields, unsafe names and malformed identities", () => {
    expect(() => parseBrowserRuntimeReleaseManifest({ ...manifest, unexpected: true })).toThrow("missing or unknown fields");
    expect(() => parseBrowserRuntimeReleaseManifest({
      ...manifest,
      controller: { ...manifest.controller, executable: "../controller" },
    })).toThrow("executable is invalid");
    expect(() => parseBrowserRuntimeReleaseManifest({
      ...manifest,
      browser: { ...manifest.browser, executableSha256: "not-a-digest" },
    })).toThrow("digest is invalid");
  });

  it("verifies host, installed filenames and both file digests before producing launch identity", async () => {
    const digestFile = vi.fn(async (path: string) => path.endsWith("/chrome")
      ? manifest.browser.executableSha256 : manifest.controller.sha256);
    const measureTree = vi.fn(async () => manifest.browser.tree);
    await expect(verifyInstalledBrowserRuntimeRelease({
      manifest,
      sourceLock,
      sourceReview,
      sourceAuthority,
      buildAttestation,
      platform: "linux",
      architecture: "x64",
      controllerPath: "/opt/traceforge/browser/traceforge-browser-controller",
      browserRootPath: "/opt/traceforge/browser/chromium",
      browserPath: "/opt/traceforge/browser/chromium/chrome",
      digestFile,
      measureTree,
    })).resolves.toEqual({
      manifest,
      identity: {
        protocol: BROWSER_RUNTIME_CONTROLLER_PROTOCOL,
        controllerVersion: manifest.controller.version,
        controllerSha256: manifest.controller.sha256,
        browserVersion: manifest.browser.version,
        browserSha256: manifest.browser.tree.sha256,
      },
      browserExecutableSha256: manifest.browser.executableSha256,
    });
    expect(digestFile).toHaveBeenCalledTimes(2);

    await expect(verifyInstalledBrowserRuntimeRelease({
      manifest,
      sourceLock,
      sourceReview,
      sourceAuthority,
      buildAttestation,
      platform: "darwin",
      architecture: "x64",
      controllerPath: "/opt/traceforge/browser/traceforge-browser-controller",
      browserRootPath: "/opt/traceforge/browser/chromium",
      browserPath: "/opt/traceforge/browser/chromium/chrome",
      digestFile,
      measureTree,
    })).rejects.toThrow("host platform");
    await expect(verifyInstalledBrowserRuntimeRelease({
      manifest,
      sourceLock,
      sourceReview,
      sourceAuthority,
      buildAttestation,
      platform: "linux",
      architecture: "x64",
      controllerPath: "/opt/traceforge/browser/traceforge-browser-controller",
      browserRootPath: "/opt/traceforge/browser/chromium",
      browserPath: "/opt/traceforge/browser/chromium/not-chrome",
      digestFile,
      measureTree,
    })).rejects.toThrow("installed paths");
    await expect(verifyInstalledBrowserRuntimeRelease({
      manifest,
      sourceLock,
      sourceReview,
      sourceAuthority,
      buildAttestation,
      platform: "linux",
      architecture: "x64",
      controllerPath: "/opt/traceforge/browser/traceforge-browser-controller",
      browserRootPath: "/opt/traceforge/browser/chromium",
      browserPath: "/opt/traceforge/browser/chromium/chrome",
      digestFile: async () => "f".repeat(64),
      measureTree,
    })).rejects.toThrow("material digest");
    await expect(verifyInstalledBrowserRuntimeRelease({
      manifest,
      sourceLock: { ...sourceLock, revision: "different-reviewed-revision" },
      sourceReview,
      sourceAuthority,
      buildAttestation,
      platform: "linux",
      architecture: "x64",
      controllerPath: "/opt/traceforge/browser/traceforge-browser-controller",
      browserRootPath: "/opt/traceforge/browser/chromium",
      browserPath: "/opt/traceforge/browser/chromium/chrome",
      digestFile,
      measureTree,
    })).rejects.toThrow("review identity");
  });
});
