import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import type { BrowserControllerIdentity } from "./index.js";
import { sha256File } from "./chromium-pipe-transport.js";
import { BROWSER_CONTROLLER_PROTOCOL } from "./execution-node-controller.js";
import { measureBrowserRuntimeTree, type BrowserRuntimeTreeMeasurement } from "./browser-runtime-tree.js";
import { selectBrowserRuntimeSourceTarget } from "./browser-runtime-source-lock.js";
import { verifyBrowserRuntimeSourceReview } from "./browser-runtime-source-review.js";
import { verifyBrowserRuntimeBuildAttestation } from "./browser-runtime-build-attestation.js";

export const BROWSER_RUNTIME_RELEASE_PROFILE = "traceforge-browser-runtime-release-v3" as const;
export { BROWSER_CONTROLLER_PROTOCOL as BROWSER_RUNTIME_CONTROLLER_PROTOCOL };

export interface BrowserRuntimeReleaseMaterial {
  executable: string;
  version: string;
  sha256: string;
}

export interface BrowserRuntimeBrowserMaterial {
  root: string;
  executable: string;
  version: string;
  executableSha256: string;
  tree: BrowserRuntimeTreeMeasurement;
}

export interface BrowserRuntimeSourceMaterial {
  lockSha256: string;
  sourceId: string;
  version: string;
  revision: string;
  archiveBytes: number;
  archiveSha256: string;
  securityReviewRef: string;
  licenseReviewRef: string;
  reviewKeyId: string;
  reviewSha256: string;
  reviewExpiresAt: string;
  buildAttestationSha256: string;
}

export interface BrowserRuntimeReleaseManifest {
  format: 3;
  profile: typeof BROWSER_RUNTIME_RELEASE_PROFILE;
  protocol: typeof BROWSER_CONTROLLER_PROTOCOL;
  platform: "darwin" | "linux" | "win32";
  architecture: "arm64" | "x64";
  source: BrowserRuntimeSourceMaterial;
  controller: BrowserRuntimeReleaseMaterial;
  browser: BrowserRuntimeBrowserMaterial;
}

const manifestKeys = ["architecture", "browser", "controller", "format", "platform", "profile", "protocol", "source"];
const controllerKeys = ["executable", "sha256", "version"];
const browserKeys = ["executable", "executableSha256", "root", "tree", "version"];
const sourceKeys = ["archiveBytes", "archiveSha256", "buildAttestationSha256", "licenseReviewRef", "lockSha256", "reviewExpiresAt", "reviewKeyId", "reviewSha256", "revision", "securityReviewRef", "sourceId", "version"];
const treeKeys = ["bytes", "entries", "sha256"];

export function browserRuntimeMaterialSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseBrowserRuntimeReleaseManifest(value: unknown): BrowserRuntimeReleaseManifest {
  const manifest = exactRecord(value, manifestKeys, "Browser Runtime release manifest");
  if (manifest.format !== 3 || manifest.profile !== BROWSER_RUNTIME_RELEASE_PROFILE
    || manifest.protocol !== BROWSER_CONTROLLER_PROTOCOL) throw new Error("Browser Runtime release manifest profile is incompatible");
  if (!(["darwin", "linux", "win32"] as const).includes(manifest.platform as never)) {
    throw new Error("Browser Runtime release platform is invalid");
  }
  if (!(["arm64", "x64"] as const).includes(manifest.architecture as never)) {
    throw new Error("Browser Runtime release architecture is invalid");
  }
  validateSource(manifest.source);
  validateController(manifest.controller);
  validateBrowser(manifest.browser);
  return structuredClone(manifest) as unknown as BrowserRuntimeReleaseManifest;
}

export function createBrowserRuntimeReleaseManifest(input: {
  platform: BrowserRuntimeReleaseManifest["platform"];
  architecture: BrowserRuntimeReleaseManifest["architecture"];
  source: BrowserRuntimeSourceMaterial;
  controller: { executable: string; version: string; bytes: Uint8Array };
  browser: BrowserRuntimeBrowserMaterial;
}): BrowserRuntimeReleaseManifest {
  return parseBrowserRuntimeReleaseManifest({
    format: 3,
    profile: BROWSER_RUNTIME_RELEASE_PROFILE,
    protocol: BROWSER_CONTROLLER_PROTOCOL,
    platform: input.platform,
    architecture: input.architecture,
    source: structuredClone(input.source),
    controller: {
      executable: input.controller.executable,
      version: input.controller.version,
      sha256: browserRuntimeMaterialSha256(input.controller.bytes),
    },
    browser: structuredClone(input.browser),
  });
}

export async function verifyInstalledBrowserRuntimeRelease(input: {
  manifest: unknown;
  sourceLock: unknown;
  sourceReview: unknown;
  sourceAuthority: unknown;
  buildAttestation: unknown;
  platform: BrowserRuntimeReleaseManifest["platform"];
  architecture: BrowserRuntimeReleaseManifest["architecture"];
  controllerPath: string;
  browserRootPath: string;
  browserPath: string;
  digestFile?: (path: string) => Promise<string>;
  measureTree?: (path: string) => Promise<BrowserRuntimeTreeMeasurement>;
  now?: string;
}): Promise<{ manifest: BrowserRuntimeReleaseManifest; identity: BrowserControllerIdentity;
  browserExecutableSha256: string }> {
  const manifest = parseBrowserRuntimeReleaseManifest(input.manifest);
  if (manifest.platform !== input.platform || manifest.architecture !== input.architecture) {
    throw new Error("Browser Runtime release does not match the current host platform");
  }
  const reviewed = verifyBrowserRuntimeSourceReview({
    sourceLock: input.sourceLock,
    sourceReview: input.sourceReview,
    authority: input.sourceAuthority,
    ...(input.now ? { now: input.now } : {}),
  });
  const built = verifyBrowserRuntimeBuildAttestation({
    sourceLock: reviewed.lock,
    attestation: input.buildAttestation,
    platform: input.platform,
    architecture: input.architecture,
  });
  const selected = selectBrowserRuntimeSourceTarget(reviewed.lock, input.platform, input.architecture);
  if (canonicalJson(manifest.source) !== canonicalJson({
    lockSha256: selected.lockSha256,
    sourceId: selected.lock.sourceId,
    version: selected.lock.version,
    revision: selected.lock.revision,
    archiveBytes: selected.target.archiveBytes,
    archiveSha256: selected.target.archiveSha256,
    securityReviewRef: selected.lock.securityReviewRef,
    licenseReviewRef: selected.lock.licenseReviewRef,
    reviewKeyId: reviewed.review.keyId,
    reviewSha256: reviewed.reviewSha256,
    reviewExpiresAt: reviewed.review.expiresAt,
    buildAttestationSha256: built.attestationSha256,
  }) || manifest.browser.root !== selected.target.rootDirectory
    || manifest.browser.executable !== selected.target.executable
    || manifest.browser.version !== selected.lock.version) {
    throw new Error("Browser Runtime release provenance does not match the trusted source lock");
  }
  if (!isAbsolute(input.controllerPath) || !isAbsolute(input.browserRootPath) || !isAbsolute(input.browserPath)
    || basename(input.controllerPath) !== manifest.controller.executable
    || basename(input.browserRootPath) !== manifest.browser.root
    || resolve(input.browserRootPath, manifest.browser.executable) !== resolve(input.browserPath)) {
    throw new Error("Browser Runtime installed paths do not match the reviewed release manifest");
  }
  const digest = input.digestFile ?? sha256File;
  const [controllerSha256, browserExecutableSha256, browserTree] = await Promise.all([
    digest(input.controllerPath),
    digest(input.browserPath),
    (input.measureTree ?? measureBrowserRuntimeTree)(input.browserRootPath),
  ]);
  if (controllerSha256 !== manifest.controller.sha256
    || browserExecutableSha256 !== manifest.browser.executableSha256
    || canonicalJson(browserTree) !== canonicalJson(manifest.browser.tree)
    || browserTree.sha256 !== built.attestation.target.browserTreeSha256) {
    throw new Error("Browser Runtime installed material digest does not match the reviewed release manifest");
  }
  return {
    manifest,
    browserExecutableSha256,
    identity: {
      protocol: BROWSER_CONTROLLER_PROTOCOL,
      controllerVersion: manifest.controller.version,
      controllerSha256,
      browserVersion: manifest.browser.version,
      browserSha256: browserTree.sha256,
    },
  };
}

function validateSource(value: unknown): void {
  const source = exactRecord(value, sourceKeys, "Browser Runtime source material");
  validateVersionAndDigest(source.version, source.archiveSha256, "source archive");
  validateVersionAndDigest(source.revision, source.lockSha256, "source lock");
  if (!Number.isSafeInteger(source.archiveBytes) || (source.archiveBytes as number) < 1
    || (source.archiveBytes as number) > 4 * 1024 * 1024 * 1024
    || !boundedIdentity(source.sourceId, 128)
    || !boundedIdentity(source.securityReviewRef, 512)
    || !boundedIdentity(source.licenseReviewRef, 512)
    || !boundedIdentity(source.reviewKeyId, 128)
    || typeof source.reviewSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.reviewSha256)
    || typeof source.buildAttestationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.buildAttestationSha256)
    || typeof source.reviewExpiresAt !== "string" || !Number.isFinite(Date.parse(source.reviewExpiresAt))
    || new Date(source.reviewExpiresAt).toISOString() !== source.reviewExpiresAt) {
    throw new Error("Browser Runtime source material is invalid");
  }
}

function validateController(value: unknown): void {
  const material = exactRecord(value, controllerKeys, "Browser Runtime controller material");
  if (typeof material.executable !== "string" || !material.executable.trim()
    || material.executable !== basename(material.executable) || /[\\/\0]/.test(material.executable)) {
    throw new Error("Browser Runtime controller executable is invalid");
  }
  validateVersionAndDigest(material.version, material.sha256, "controller");
}

function validateBrowser(value: unknown): void {
  const material = exactRecord(value, browserKeys, "Browser Runtime browser material");
  if (typeof material.root !== "string" || !material.root.trim() || material.root !== basename(material.root)
    || /[\\/\0]/.test(material.root) || typeof material.executable !== "string"
    || !safeRelativePath(material.executable)) throw new Error("Browser Runtime browser path is invalid");
  validateVersionAndDigest(material.version, material.executableSha256, "browser executable");
  const tree = exactRecord(material.tree, treeKeys, "Browser Runtime browser tree");
  if (typeof tree.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(tree.sha256)
    || !Number.isSafeInteger(tree.entries) || (tree.entries as number) < 1
    || !Number.isSafeInteger(tree.bytes) || (tree.bytes as number) < 1) {
    throw new Error("Browser Runtime browser tree measurement is invalid");
  }
}

function validateVersionAndDigest(version: unknown, digest: unknown, label: string): void {
  if (!boundedIdentity(version, 128)) {
    throw new Error(`Browser Runtime ${label} version is invalid`);
  }
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Browser Runtime ${label} digest is invalid`);
  }
}

function boundedIdentity(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && Buffer.byteLength(value) <= maximumBytes
    && !/[\0\r\n]/.test(value);
}

function safeRelativePath(value: string): boolean {
  if (!value.trim() || isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value) > 4096) return false;
  return value.split(/[\\/]/).every((part) => Boolean(part) && part !== "." && part !== "..");
}

function canonicalJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)) {
    throw new Error(`${label} has missing or unknown fields`);
  }
  return record;
}
