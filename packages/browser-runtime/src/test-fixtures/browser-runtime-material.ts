import {
  BROWSER_RUNTIME_BUILD_ATTESTATION_PROFILE,
  BROWSER_RUNTIME_CHROMIUM_SOURCE_REPOSITORY,
  type BrowserRuntimeBuildAttestation,
} from "../browser-runtime-build-attestation.js";
import type { BrowserRuntimeSourceTarget } from "../browser-runtime-source-lock.js";

export function createTestBrowserRuntimeBuildAttestation(input: {
  version: string;
  revision: string;
  target: BrowserRuntimeSourceTarget;
  browserTreeSha256: string;
}): BrowserRuntimeBuildAttestation {
  const platformSignature = input.target.platform === "darwin"
    ? { kind: "apple-developer-id" as const, identitySha256: "9".repeat(64) }
    : input.target.platform === "win32"
      ? { kind: "authenticode" as const, identitySha256: "9".repeat(64) }
      : null;
  return {
    format: 1,
    profile: BROWSER_RUNTIME_BUILD_ATTESTATION_PROFILE,
    createdAt: "2026-09-03T23:59:00.000Z",
    source: {
      repository: BROWSER_RUNTIME_CHROMIUM_SOURCE_REPOSITORY,
      chromiumCommit: input.revision,
      chromiumVersion: input.version,
      sourceManifestSha256: "1".repeat(64),
    },
    toolchain: {
      depotToolsCommit: "2".repeat(40),
      dependencyManifestSha256: "3".repeat(64),
      gnArgsSha256: "4".repeat(64),
      buildRecipeSha256: "5".repeat(64),
    },
    target: { ...structuredClone(input.target), browserTreeSha256: input.browserTreeSha256 },
    compliance: {
      sbomFormat: "spdx-json-2.3",
      sbomBytes: 1024,
      sbomSha256: "6".repeat(64),
      noticesBytes: 512,
      noticesSha256: "7".repeat(64),
      securityAssessmentSha256: "8".repeat(64),
      licenseReviewSha256: "a".repeat(64),
      platformSignature,
    },
    reproductions: [
      { builderId: "independent-builder-a", buildEnvironmentSha256: "b".repeat(64),
        provenanceSha256: "c".repeat(64), browserTreeSha256: input.browserTreeSha256 },
      { builderId: "independent-builder-b", buildEnvironmentSha256: "d".repeat(64),
        provenanceSha256: "e".repeat(64), browserTreeSha256: input.browserTreeSha256 },
    ],
  };
}
