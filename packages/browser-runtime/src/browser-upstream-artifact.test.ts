import { expect, it } from "vitest";
import { parseUpstreamArtifact, upstreamArtifactSha256, verifyBrowserRuntimeProvenance, UPSTREAM_ARTIFACT_PROFILE } from "./browser-upstream-artifact.js";
const target = { platform: "darwin", architecture: "arm64", archiveFormat: "zip", archiveBytes: 123,
  archiveSha256: "a".repeat(64), rootDirectory: "chrome-headless-shell-mac-arm64", executable: "chrome-headless-shell",
  url: "https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.52/mac-arm64/chrome-headless-shell-mac-arm64.zip" };
const artifact = { format: 1, profile: UPSTREAM_ARTIFACT_PROFILE, createdAt: "2026-09-20T00:00:00.000Z", version: "HeadlessChrome/153.0.8010.52", revision: "1681091",
  metadataUrl: "https://googlechromelabs.github.io/chrome-for-testing/153.0.8010.52.json", metadataSha256: "b".repeat(64), target: { ...target, browserTreeSha256: "c".repeat(64) },
  securityAssessmentSha256: "d".repeat(64), licenseReviewSha256: "e".repeat(64), assurance: "official-binary-adoption-not-reproducible-build" };
const lock = () => ({ format: 1, profile: "traceforge-browser-runtime-source-lock-v1", sourceId: "google-official-headless-shell", version: artifact.version,
  revision: artifact.revision, createdAt: artifact.createdAt, targets: [target], buildAttestationSha256: upstreamArtifactSha256(artifact),
  securityReviewRef: `sha256:${artifact.securityAssessmentSha256}`, licenseReviewRef: `sha256:${artifact.licenseReviewSha256}` });
it("distinguishes official binary adoption from independent source-build assurance", () => {
  const result = verifyBrowserRuntimeProvenance({ sourceLock: lock(), attestation: artifact, platform: "darwin", architecture: "arm64" });
  expect(result.attestation.target.browserTreeSha256).toBe("c".repeat(64));
  expect(result.attestation).not.toHaveProperty("reproductions");
});
it("rejects mirror substitutions, different revisions, unknown claims and arbitrary platforms", () => {
  for (const value of [ { ...artifact, target: { ...artifact.target, url: "https://example.invalid/browser.zip" } },
    { ...artifact, version: "HeadlessChrome/153.0.8010.53" }, { ...artifact, reproductions: [] }, { ...artifact, assurance: "security-audited" },
    { ...artifact, target: { ...artifact.target, platform: "linux" } } ]) expect(() => parseUpstreamArtifact(value)).toThrow();
});
it("requires signed-lock agreement for hashes, scope and adoption references", () => {
  for (const changed of [{ ...lock(), sourceId: "another-source" }, { ...lock(), buildAttestationSha256: "f".repeat(64) },
    { ...lock(), securityReviewRef: "invented" }]) expect(() => verifyBrowserRuntimeProvenance({ sourceLock: changed, attestation: artifact, platform: "darwin", architecture: "arm64" })).toThrow();
});
