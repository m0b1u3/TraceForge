import { createHash } from "node:crypto";
import { stat, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sha256File } from "./chromium-pipe-transport.js";

export const BROWSER_RUNTIME_SOURCE_LOCK_PROFILE = "traceforge-browser-runtime-source-lock-v1" as const;

export interface BrowserRuntimeSourceTarget {
  platform: "darwin" | "linux" | "win32";
  architecture: "arm64" | "x64";
  archiveFormat: "zip";
  url: string;
  archiveBytes: number;
  archiveSha256: string;
  rootDirectory: string;
  executable: string;
}

export interface BrowserRuntimeSourceLock {
  format: 1;
  profile: typeof BROWSER_RUNTIME_SOURCE_LOCK_PROFILE;
  sourceId: string;
  version: string;
  revision: string;
  createdAt: string;
  buildAttestationSha256: string;
  securityReviewRef: string;
  licenseReviewRef: string;
  targets: BrowserRuntimeSourceTarget[];
}

const lockKeys = [
  "buildAttestationSha256", "createdAt", "format", "licenseReviewRef", "profile", "revision", "securityReviewRef",
  "sourceId", "targets", "version",
];
const targetKeys = [
  "architecture", "archiveBytes", "archiveFormat", "archiveSha256", "executable",
  "platform", "rootDirectory", "url",
];

export function parseBrowserRuntimeSourceLock(value: unknown): BrowserRuntimeSourceLock {
  const lock = exactRecord(value, lockKeys, "Browser Runtime source lock");
  if (lock.format !== 1 || lock.profile !== BROWSER_RUNTIME_SOURCE_LOCK_PROFILE) {
    throw new Error("Browser Runtime source lock profile is incompatible");
  }
  boundedIdentity(lock.sourceId, "source identity", 128);
  boundedIdentity(lock.version, "version", 128);
  boundedIdentity(lock.revision, "revision", 128);
  if (typeof lock.buildAttestationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(lock.buildAttestationSha256)) {
    throw new Error("Browser Runtime build attestation digest is invalid");
  }
  boundedIdentity(lock.securityReviewRef, "security review reference", 512);
  boundedIdentity(lock.licenseReviewRef, "license review reference", 512);
  if (typeof lock.createdAt !== "string" || !Number.isFinite(Date.parse(lock.createdAt))
    || new Date(lock.createdAt).toISOString() !== lock.createdAt) {
    throw new Error("Browser Runtime source lock timestamp is invalid");
  }
  if (!Array.isArray(lock.targets) || lock.targets.length < 1 || lock.targets.length > 16) {
    throw new Error("Browser Runtime source target count is invalid");
  }
  const targets = lock.targets.map(parseTarget);
  const identities = new Set<string>();
  for (const target of targets) {
    const identity = target.platform + "/" + target.architecture;
    if (identities.has(identity)) throw new Error("Browser Runtime source target identity is duplicated");
    identities.add(identity);
  }
  return structuredClone({ ...lock, targets }) as unknown as BrowserRuntimeSourceLock;
}

export function browserRuntimeSourceLockSha256(value: unknown): string {
  const lock = parseBrowserRuntimeSourceLock(value);
  return createHash("sha256").update(canonicalJson(lock)).digest("hex");
}

export function selectBrowserRuntimeSourceTarget(
  value: unknown,
  platform: BrowserRuntimeSourceTarget["platform"],
  architecture: BrowserRuntimeSourceTarget["architecture"],
): { lock: BrowserRuntimeSourceLock; lockSha256: string; target: BrowserRuntimeSourceTarget } {
  const lock = parseBrowserRuntimeSourceLock(value);
  const target = lock.targets.find((candidate) =>
    candidate.platform === platform && candidate.architecture === architecture);
  if (!target) throw new Error("Browser Runtime source lock has no target for the current host");
  return {
    lock,
    lockSha256: createHash("sha256").update(canonicalJson(lock)).digest("hex"),
    target: structuredClone(target),
  };
}

export async function verifyBrowserRuntimeSourceArchive(input: {
  target: BrowserRuntimeSourceTarget;
  archivePath: string;
  digestFile?: (path: string) => Promise<string>;
}): Promise<{ bytes: number; sha256: string }> {
  parseTarget(input.target);
  if (!isAbsolute(input.archivePath)) throw new Error("Browser Runtime source archive path must be absolute");
  const before = await stat(input.archivePath);
  if (!before.isFile() || before.size !== input.target.archiveBytes) {
    throw new Error("Browser Runtime source archive size does not match its source lock");
  }
  const sha256 = await (input.digestFile ?? sha256File)(input.archivePath);
  const after = await stat(input.archivePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Browser Runtime source archive changed while being verified");
  }
  if (sha256 !== input.target.archiveSha256) {
    throw new Error("Browser Runtime source archive digest does not match its source lock");
  }
  return { bytes: after.size, sha256 };
}

export async function verifyBrowserRuntimeSourceArchiveHandle(input: {
  target: BrowserRuntimeSourceTarget;
  archive: FileHandle;
}): Promise<{ bytes: number; sha256: string }> {
  parseTarget(input.target);
  const before = await input.archive.stat();
  if (!before.isFile() || before.size !== input.target.archiveBytes) {
    throw new Error("Browser Runtime source archive size does not match its source lock");
  }
  const hash = createHash("sha256");
  const stream = input.archive.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const after = await input.archive.stat();
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Browser Runtime source archive changed while being verified");
  }
  if (sha256 !== input.target.archiveSha256) {
    throw new Error("Browser Runtime source archive digest does not match its source lock");
  }
  return { bytes: after.size, sha256 };
}

function parseTarget(value: unknown): BrowserRuntimeSourceTarget {
  const target = exactRecord(value, targetKeys, "Browser Runtime source target");
  if (!["darwin", "linux", "win32"].includes(String(target.platform))
    || !["arm64", "x64"].includes(String(target.architecture)) || target.archiveFormat !== "zip") {
    throw new Error("Browser Runtime source target host identity is invalid");
  }
  let url: URL;
  try { url = new URL(String(target.url)); }
  catch { throw new Error("Browser Runtime source target URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || typeof target.url !== "string" || target.url !== url.href || Buffer.byteLength(target.url) > 4096) {
    throw new Error("Browser Runtime source target URL is invalid");
  }
  if (!Number.isSafeInteger(target.archiveBytes) || (target.archiveBytes as number) < 1
    || (target.archiveBytes as number) > 4 * 1024 * 1024 * 1024) {
    throw new Error("Browser Runtime source archive size is invalid");
  }
  if (typeof target.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(target.archiveSha256)) {
    throw new Error("Browser Runtime source archive digest is invalid");
  }
  if (typeof target.rootDirectory !== "string" || !safePath(target.rootDirectory, false)
    || typeof target.executable !== "string" || !safePath(target.executable, true)) {
    throw new Error("Browser Runtime source archive layout is invalid");
  }
  return structuredClone(target) as unknown as BrowserRuntimeSourceTarget;
}

function safePath(value: string, nested: boolean): boolean {
  if (!value.trim() || isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value) > 4096) return false;
  const parts = value.split(/[\\/]/);
  return parts.every(safePathPart)
    && (nested || parts.length === 1);
}

function safePathPart(value: string): boolean {
  const stem = value.split(".", 1)[0]!;
  return Boolean(value) && value !== "." && value !== ".." && !value.includes(":")
    && !/[. ]$/.test(value) && !/[\u0000-\u001f]/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
}

function boundedIdentity(value: unknown, label: string, maximumBytes: number): void {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximumBytes
    || /[\0\r\n]/.test(value)) throw new Error("Browser Runtime " + label + " is invalid");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)) {
    throw new Error(label + " has missing or unknown fields");
  }
  return record;
}
