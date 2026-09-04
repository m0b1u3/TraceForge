import { createHash } from "node:crypto";
import {
  BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  parseBrowserRuntimeSourceLock,
  selectBrowserRuntimeSourceTarget,
  type BrowserRuntimeSourceLock,
  type BrowserRuntimeSourceTarget,
} from "./browser-runtime-source-lock.js";

export const BROWSER_RUNTIME_BUILD_ATTESTATION_PROFILE = "traceforge-browser-runtime-build-attestation-v1" as const;
export const BROWSER_RUNTIME_CHROMIUM_SOURCE_REPOSITORY = "https://chromium.googlesource.com/chromium/src.git" as const;

export interface BrowserRuntimeBuildAttestation {
  format: 1;
  profile: typeof BROWSER_RUNTIME_BUILD_ATTESTATION_PROFILE;
  createdAt: string;
  source: {
    repository: string;
    chromiumCommit: string;
    chromiumVersion: string;
    sourceManifestSha256: string;
  };
  toolchain: {
    depotToolsCommit: string;
    dependencyManifestSha256: string;
    gnArgsSha256: string;
    buildRecipeSha256: string;
  };
  target: BrowserRuntimeSourceTarget & { browserTreeSha256: string };
  compliance: {
    sbomFormat: "spdx-json-2.3" | "cyclonedx-json-1.6";
    sbomBytes: number;
    sbomSha256: string;
    noticesBytes: number;
    noticesSha256: string;
    securityAssessmentSha256: string;
    licenseReviewSha256: string;
    platformSignature: { kind: "apple-developer-id" | "authenticode"; identitySha256: string } | null;
  };
  reproductions: Array<{
    builderId: string;
    buildEnvironmentSha256: string;
    provenanceSha256: string;
    browserTreeSha256: string;
  }>;
}

const rootKeys = ["compliance", "createdAt", "format", "profile", "reproductions", "source", "target", "toolchain"];
const sourceKeys = ["chromiumCommit", "chromiumVersion", "repository", "sourceManifestSha256"];
const toolchainKeys = ["buildRecipeSha256", "dependencyManifestSha256", "depotToolsCommit", "gnArgsSha256"];
const targetKeys = ["architecture", "archiveBytes", "archiveFormat", "archiveSha256", "browserTreeSha256", "executable", "platform", "rootDirectory", "url"];
const complianceKeys = ["licenseReviewSha256", "noticesBytes", "noticesSha256", "platformSignature", "sbomBytes", "sbomFormat", "sbomSha256", "securityAssessmentSha256"];
const signatureKeys = ["identitySha256", "kind"];
const reproductionKeys = ["browserTreeSha256", "buildEnvironmentSha256", "builderId", "provenanceSha256"];

export function browserRuntimeBuildAttestationSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(parseBrowserRuntimeBuildAttestation(value))).digest("hex");
}

export function parseBrowserRuntimeBuildAttestation(value: unknown): BrowserRuntimeBuildAttestation {
  const root = exactRecord(value, rootKeys, "Browser Runtime build attestation");
  if (root.format !== 1 || root.profile !== BROWSER_RUNTIME_BUILD_ATTESTATION_PROFILE) {
    throw new Error("Browser Runtime build attestation profile is incompatible");
  }
  const createdAt = timestamp(root.createdAt, "build timestamp");
  const source = exactRecord(root.source, sourceKeys, "Browser Runtime build source");
  let repository: URL;
  try { repository = new URL(String(source.repository)); }
  catch { throw new Error("Browser Runtime build source repository is invalid"); }
  if (repository.protocol !== "https:" || repository.username || repository.password || repository.hash
    || source.repository !== repository.href || repository.href !== BROWSER_RUNTIME_CHROMIUM_SOURCE_REPOSITORY) {
    throw new Error("Browser Runtime build source repository is invalid");
  }
  const parsedSource = {
    repository: repository.href,
    chromiumCommit: commit(source.chromiumCommit, "Chromium commit"),
    chromiumVersion: identity(source.chromiumVersion, "Chromium version", 128),
    sourceManifestSha256: digest(source.sourceManifestSha256, "source manifest"),
  };
  const toolchain = exactRecord(root.toolchain, toolchainKeys, "Browser Runtime build toolchain");
  const parsedToolchain = {
    depotToolsCommit: commit(toolchain.depotToolsCommit, "depot_tools commit"),
    dependencyManifestSha256: digest(toolchain.dependencyManifestSha256, "dependency manifest"),
    gnArgsSha256: digest(toolchain.gnArgsSha256, "GN arguments"),
    buildRecipeSha256: digest(toolchain.buildRecipeSha256, "build recipe"),
  };
  const target = parseTarget(root.target);
  const compliance = parseCompliance(root.compliance);
  if ((target.platform === "darwin" && compliance.platformSignature?.kind !== "apple-developer-id")
    || (target.platform === "win32" && compliance.platformSignature?.kind !== "authenticode")
    || (target.platform === "linux" && compliance.platformSignature !== null)) {
    throw new Error("Browser Runtime build platform signature does not match the target platform");
  }
  if (!Array.isArray(root.reproductions) || root.reproductions.length < 2 || root.reproductions.length > 8) {
    throw new Error("Browser Runtime build requires at least two bounded reproductions");
  }
  const reproductions = root.reproductions.map(parseReproduction);
  if (new Set(reproductions.map((item) => item.builderId)).size !== reproductions.length
    || new Set(reproductions.map((item) => item.buildEnvironmentSha256)).size !== reproductions.length
    || new Set(reproductions.map((item) => item.provenanceSha256)).size !== reproductions.length
    || reproductions.some((item) => item.browserTreeSha256 !== target.browserTreeSha256)) {
    throw new Error("Browser Runtime build reproductions are not independent or do not match the target tree");
  }
  return structuredClone({
    format: 1,
    profile: BROWSER_RUNTIME_BUILD_ATTESTATION_PROFILE,
    createdAt,
    source: parsedSource,
    toolchain: parsedToolchain,
    target,
    compliance,
    reproductions,
  });
}

export function verifyBrowserRuntimeBuildAttestation(input: {
  sourceLock: unknown;
  attestation: unknown;
  platform: BrowserRuntimeSourceTarget["platform"];
  architecture: BrowserRuntimeSourceTarget["architecture"];
}): { lock: BrowserRuntimeSourceLock; target: BrowserRuntimeSourceTarget;
  attestation: BrowserRuntimeBuildAttestation; attestationSha256: string } {
  const lock = parseBrowserRuntimeSourceLock(input.sourceLock);
  const selected = selectBrowserRuntimeSourceTarget(lock, input.platform, input.architecture);
  const attestation = parseBrowserRuntimeBuildAttestation(input.attestation);
  const attestationSha256 = createHash("sha256").update(canonicalJson(attestation)).digest("hex");
  const { browserTreeSha256: _tree, ...attestedTarget } = attestation.target;
  if (attestation.source.chromiumVersion !== lock.version || attestation.source.chromiumCommit !== lock.revision
    || canonicalJson(attestedTarget) !== canonicalJson(selected.target)
    || lock.securityReviewRef !== `sha256:${attestation.compliance.securityAssessmentSha256}`
    || lock.licenseReviewRef !== `sha256:${attestation.compliance.licenseReviewSha256}`
    || lock.buildAttestationSha256 !== attestationSha256) {
    throw new Error("Browser Runtime build attestation does not match its source lock");
  }
  return {
    lock,
    target: selected.target,
    attestation,
    attestationSha256,
  };
}

function parseTarget(value: unknown): BrowserRuntimeBuildAttestation["target"] {
  const target = exactRecord(value, targetKeys, "Browser Runtime attested target");
  const lock = parseBrowserRuntimeSourceLock({
    format: 1,
    profile: BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
    sourceId: "attestation-layout-validation",
    version: "attestation-layout-validation",
    revision: "attestation-layout-validation",
    createdAt: "2000-01-01T00:00:00.000Z",
    buildAttestationSha256: "0".repeat(64),
    securityReviewRef: "attestation-layout-validation",
    licenseReviewRef: "attestation-layout-validation",
    targets: [{
      platform: target.platform,
      architecture: target.architecture,
      archiveFormat: target.archiveFormat,
      url: target.url,
      archiveBytes: target.archiveBytes,
      archiveSha256: target.archiveSha256,
      rootDirectory: target.rootDirectory,
      executable: target.executable,
    }],
  }).targets[0]!;
  return { ...lock, browserTreeSha256: digest(target.browserTreeSha256, "browser tree") };
}

function parseCompliance(value: unknown): BrowserRuntimeBuildAttestation["compliance"] {
  const compliance = exactRecord(value, complianceKeys, "Browser Runtime build compliance");
  if (compliance.sbomFormat !== "spdx-json-2.3" && compliance.sbomFormat !== "cyclonedx-json-1.6") {
    throw new Error("Browser Runtime build SBOM format is invalid");
  }
  const platformSignature = compliance.platformSignature === null ? null : (() => {
    const signature = exactRecord(compliance.platformSignature, signatureKeys, "Browser Runtime platform signature");
    if (signature.kind !== "apple-developer-id" && signature.kind !== "authenticode") {
      throw new Error("Browser Runtime platform signature kind is invalid");
    }
    return {
      kind: signature.kind as "apple-developer-id" | "authenticode",
      identitySha256: digest(signature.identitySha256, "platform signature identity"),
    };
  })();
  return {
    sbomFormat: compliance.sbomFormat,
    sbomBytes: positiveBytes(compliance.sbomBytes, "SBOM"),
    sbomSha256: digest(compliance.sbomSha256, "SBOM"),
    noticesBytes: positiveBytes(compliance.noticesBytes, "notices"),
    noticesSha256: digest(compliance.noticesSha256, "notices"),
    securityAssessmentSha256: digest(compliance.securityAssessmentSha256, "security assessment"),
    licenseReviewSha256: digest(compliance.licenseReviewSha256, "license review"),
    platformSignature,
  };
}

function parseReproduction(value: unknown): BrowserRuntimeBuildAttestation["reproductions"][number] {
  const reproduction = exactRecord(value, reproductionKeys, "Browser Runtime build reproduction");
  return {
    builderId: identity(reproduction.builderId, "builder identity", 128),
    buildEnvironmentSha256: digest(reproduction.buildEnvironmentSha256, "build environment"),
    provenanceSha256: digest(reproduction.provenanceSha256, "build provenance"),
    browserTreeSha256: digest(reproduction.browserTreeSha256, "reproduced browser tree"),
  };
}

function positiveBytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1024 * 1024 * 1024) {
    throw new Error(`Browser Runtime build ${label} size is invalid`);
  }
  return value as number;
}

function commit(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`Browser Runtime build ${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Browser Runtime build ${label} digest is invalid`);
  }
  return value;
}

function identity(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximumBytes
    || /[\0\r\n]/.test(value)) throw new Error(`Browser Runtime build ${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new Error(`Browser Runtime ${label} is invalid`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
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
