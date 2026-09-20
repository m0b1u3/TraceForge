import { createHash } from "node:crypto";
import { parseBrowserRuntimeSourceLock, selectBrowserRuntimeSourceTarget, type BrowserRuntimeSourceTarget } from "./browser-runtime-source-lock.js";
import { verifyBrowserRuntimeBuildAttestation } from "./browser-runtime-build-attestation.js";

export const UPSTREAM_ARTIFACT_PROFILE = "traceforge-browser-upstream-artifact-v1" as const;
/** Adoption of an official binary is not a claim of independent reproduction,
 * a vulnerability audit, notarization, or legal clearance for redistribution. */
export interface BrowserUpstreamArtifact {
  format: 1; profile: typeof UPSTREAM_ARTIFACT_PROFILE; createdAt: string;
  version: string; revision: string; metadataUrl: string; metadataSha256: string;
  target: BrowserRuntimeSourceTarget & { browserTreeSha256: string };
  securityAssessmentSha256: string; licenseReviewSha256: string;
  assurance: "official-binary-adoption-not-reproducible-build";
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
export function upstreamArtifactSha256(value: unknown): string { return hash(parseUpstreamArtifact(value)); }
export function parseUpstreamArtifact(value: unknown): BrowserUpstreamArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid upstream artifact");
  const v = value as BrowserUpstreamArtifact;
  const keys = ["format", "profile", "createdAt", "version", "revision", "metadataUrl", "metadataSha256", "target", "securityAssessmentSha256", "licenseReviewSha256", "assurance"];
  if (Object.keys(v).sort().join() !== keys.sort().join() || v.format !== 1 || v.profile !== UPSTREAM_ARTIFACT_PROFILE
    || v.assurance !== "official-binary-adoption-not-reproducible-build" || !/^HeadlessChrome\/\d+\.\d+\.\d+\.\d+$/.test(v.version)
    || !/^\d{6,10}$/.test(v.revision) || !Number.isFinite(Date.parse(v.createdAt)) || new Date(v.createdAt).toISOString() !== v.createdAt)
    throw new Error("Invalid upstream artifact identity");
  for (const digest of [v.metadataSha256, v.securityAssessmentSha256, v.licenseReviewSha256, v.target?.browserTreeSha256])
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid upstream artifact digest");
  const target = v.target;
  if (!target || Object.keys(target).sort().join() !== ["platform", "architecture", "archiveFormat", "url", "archiveBytes", "archiveSha256", "rootDirectory", "executable", "browserTreeSha256"].sort().join()
    || target.platform !== "darwin" || target.architecture !== "arm64" || target.rootDirectory !== "chrome-headless-shell-mac-arm64"
    || target.executable !== "chrome-headless-shell"
    || target.url !== `https://storage.googleapis.com/chrome-for-testing-public/${v.version.split("/")[1]}/mac-arm64/chrome-headless-shell-mac-arm64.zip`
    || v.metadataUrl !== `https://googlechromelabs.github.io/chrome-for-testing/${v.version.split("/")[1]}.json`)
    throw new Error("Upstream artifact must use the approved official platform source");
  const { browserTreeSha256: _tree, ...sourceTarget } = target;
  parseBrowserRuntimeSourceLock({ format: 1, profile: "traceforge-browser-runtime-source-lock-v1", sourceId: "google-official-headless-shell",
    version: v.version, revision: v.revision, createdAt: v.createdAt, buildAttestationSha256: "0".repeat(64),
    securityReviewRef: `sha256:${v.securityAssessmentSha256}`, licenseReviewRef: `sha256:${v.licenseReviewSha256}`, targets: [sourceTarget] });
  return structuredClone(v);
}

export function verifyBrowserRuntimeProvenance(input: Parameters<typeof verifyBrowserRuntimeBuildAttestation>[0]) {
  if ((input.attestation as { profile?: unknown } | null)?.profile !== UPSTREAM_ARTIFACT_PROFILE)
    return verifyBrowserRuntimeBuildAttestation(input);
  const attestation = parseUpstreamArtifact(input.attestation), lock = parseBrowserRuntimeSourceLock(input.sourceLock);
  const selected = selectBrowserRuntimeSourceTarget(lock, input.platform, input.architecture), attestationSha256 = hash(attestation);
  const { browserTreeSha256: _tree, ...target } = attestation.target;
  if (lock.sourceId !== "google-official-headless-shell" || lock.version !== attestation.version || lock.revision !== attestation.revision
    || canonical(selected.target) !== canonical(target) || lock.buildAttestationSha256 !== attestationSha256
    || lock.securityReviewRef !== `sha256:${attestation.securityAssessmentSha256}` || lock.licenseReviewRef !== `sha256:${attestation.licenseReviewSha256}`)
    throw new Error("Upstream artifact does not match its signed source lock");
  return { lock, target: selected.target, attestation, attestationSha256 };
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  return JSON.stringify(v);
}
