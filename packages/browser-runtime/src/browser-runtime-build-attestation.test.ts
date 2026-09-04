import { describe, expect, it } from "vitest";
import {
  BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  browserRuntimeBuildAttestationSha256,
  parseBrowserRuntimeBuildAttestation,
  verifyBrowserRuntimeBuildAttestation,
  type BrowserRuntimeSourceLock,
} from "./index.js";
import { createTestBrowserRuntimeBuildAttestation } from "./test-fixtures/browser-runtime-material.js";

const target = {
  platform: "linux" as const,
  architecture: "x64" as const,
  archiveFormat: "zip" as const,
  url: "https://downloads.example.invalid/chromium-linux-x64.zip",
  archiveBytes: 4096,
  archiveSha256: "f".repeat(64),
  rootDirectory: "chromium",
  executable: "chrome",
};
const attestation = createTestBrowserRuntimeBuildAttestation({
  version: "140.0.0.0",
  revision: "1".repeat(40),
  target,
  browserTreeSha256: "0".repeat(64),
});
const lock: BrowserRuntimeSourceLock = {
  format: 1,
  profile: BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  sourceId: "traceforge-reviewed-chromium-build",
  version: attestation.source.chromiumVersion,
  revision: attestation.source.chromiumCommit,
  createdAt: "2026-09-04T00:00:00.000Z",
  buildAttestationSha256: browserRuntimeBuildAttestationSha256(attestation),
  securityReviewRef: `sha256:${attestation.compliance.securityAssessmentSha256}`,
  licenseReviewRef: `sha256:${attestation.compliance.licenseReviewSha256}`,
  targets: [target],
};

describe("Browser Runtime build attestation", () => {
  it("binds official Chromium source, toolchain, compliance and two independent matching reproductions to the source lock", () => {
    expect(verifyBrowserRuntimeBuildAttestation({
      sourceLock: lock,
      attestation,
      platform: "linux",
      architecture: "x64",
    })).toMatchObject({ lock, target, attestation, attestationSha256: lock.buildAttestationSha256 });
  });

  it("fails closed for unofficial source, incomplete reproduction or wrong platform signature", () => {
    expect(() => parseBrowserRuntimeBuildAttestation({
      ...attestation,
      source: { ...attestation.source, repository: "https://example.invalid/chromium.git" },
    })).toThrow("repository is invalid");
    expect(() => parseBrowserRuntimeBuildAttestation({ ...attestation, reproductions: [attestation.reproductions[0]!] }))
      .toThrow("at least two");
    expect(() => parseBrowserRuntimeBuildAttestation({
      ...attestation,
      reproductions: attestation.reproductions.map((entry) => ({
        ...entry,
        buildEnvironmentSha256: attestation.reproductions[0]!.buildEnvironmentSha256,
      })),
    })).toThrow("not independent");
    expect(() => parseBrowserRuntimeBuildAttestation({
      ...attestation,
      compliance: { ...attestation.compliance,
        platformSignature: { kind: "authenticode", identitySha256: "9".repeat(64) } },
    })).toThrow("target platform");
  });

  it("rejects changed evidence even when all source coordinates still match", () => {
    const changed = { ...attestation, toolchain: { ...attestation.toolchain, gnArgsSha256: "9".repeat(64) } };
    expect(() => verifyBrowserRuntimeBuildAttestation({
      sourceLock: lock,
      attestation: changed,
      platform: "linux",
      architecture: "x64",
    })).toThrow("does not match its source lock");
  });
});
