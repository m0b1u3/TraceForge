import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify, type KeyLike } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  canonicalJson,
  resolveToolProviderEntrypoint,
  validateToolProviderManifest,
  validateToolProviderSignature,
  type ToolProviderManifest,
  type ToolProviderSignature,
} from "./tool-provider-control-plane.js";
import {
  DEFAULT_TOOL_PROVIDER_PACKAGE_POLICY,
  inspectToolProviderPackage,
  type ToolProviderPackageInventory,
  type ToolProviderPackagePolicy,
} from "./tool-provider-package-store.js";

export const TOOL_PROVIDER_ARCHIVE_FORMAT = "traceforge.tool-provider.archive" as const;
export const TOOL_PROVIDER_ARCHIVE_VERSION = 1 as const;

export interface ToolProviderArchivePolicy extends ToolProviderPackagePolicy {
  maximumArchiveBytes: number;
  maximumEnvelopeBytes: number;
  maximumEntries: number;
  maximumPathBytes: number;
}

export const DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY: ToolProviderArchivePolicy = {
  ...DEFAULT_TOOL_PROVIDER_PACKAGE_POLICY,
  maximumArchiveBytes: 384 * 1024 * 1024,
  maximumEnvelopeBytes: 384 * 1024 * 1024,
  maximumEntries: 20_000,
  maximumPathBytes: 1_024,
};

interface DirectoryEntry {
  path: string;
  type: "directory";
}

interface FileEntry {
  path: string;
  type: "file";
  bytes: number;
  executable: boolean;
  sha256: string;
  contentBase64: string;
}

type ArchiveEntry = DirectoryEntry | FileEntry;

interface ToolProviderArchiveEnvelope {
  format: typeof TOOL_PROVIDER_ARCHIVE_FORMAT;
  schemaVersion: typeof TOOL_PROVIDER_ARCHIVE_VERSION;
  manifest: ToolProviderManifest;
  signature: ToolProviderSignature;
  entries: ArchiveEntry[];
}

export interface PublishedToolProviderArchive {
  archivePath: string;
  manifest: ToolProviderManifest;
  signature: ToolProviderSignature;
  package: ToolProviderPackageInventory;
  archiveSha256: string;
  archiveBytes: number;
}

export interface ExtractedToolProviderArchive {
  packageRoot: string;
  manifest: ToolProviderManifest;
  signature: ToolProviderSignature;
  package: ToolProviderPackageInventory;
}

export class ToolProviderArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolProviderArchiveError";
  }
}

export function createSignedToolProviderArchive(input: {
  sourceRoot: string;
  manifestValue: unknown;
  privateKey: KeyLike | string | Buffer;
  keyId: string;
  archivePath: string;
  policy?: ToolProviderArchivePolicy;
}): PublishedToolProviderArchive {
  const policy = validatePolicy(input.policy ?? DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY);
  const sourceRoot = realDirectory(input.sourceRoot, "Tool Provider archive source");
  const archivePath = resolve(input.archivePath);
  if (existsSync(archivePath)) throw new ToolProviderArchiveError(`Refusing to overwrite existing archive ${archivePath}`);
  const packageInventory = inspectToolProviderPackage(sourceRoot, policy);
  const entries = collectEntries(sourceRoot, policy);
  const confirmedInventory = inspectToolProviderPackage(sourceRoot, policy);
  if (confirmedInventory.digest !== packageInventory.digest
    || confirmedInventory.files !== packageInventory.files
    || confirmedInventory.bytes !== packageInventory.bytes) {
    throw new ToolProviderArchiveError("Tool Provider package changed while the archive was being assembled");
  }
  const draft = requireRecord(input.manifestValue, "Tool Provider manifest");
  const draftEntrypoint = requireRecord(draft.entrypoint, "Tool Provider manifest entrypoint");
  const executablePath = portableRelativePath(draftEntrypoint.executable, "entrypoint executable", policy.maximumPathBytes, false);
  const executable = entries.find((entry): entry is FileEntry => entry.type === "file" && entry.path === executablePath);
  if (!executable) throw new ToolProviderArchiveError(`Tool Provider entrypoint ${executablePath} is not a packaged file`);
  if (process.platform !== "win32" && !executable.executable) {
    throw new ToolProviderArchiveError(`Tool Provider entrypoint ${executablePath} is not executable`);
  }
  const manifest = validateToolProviderManifest({
    ...draft,
    artifact: { sha256: executable.sha256, packageSha256: packageInventory.digest },
  });
  const resolvedEntrypoint = resolveToolProviderEntrypoint(manifest, sourceRoot);
  if (!statSync(resolvedEntrypoint.workingDirectory).isDirectory()) {
    throw new ToolProviderArchiveError(`Tool Provider working directory ${manifest.entrypoint.workingDirectory} is not a directory`);
  }
  const keyId = identifier(input.keyId, "signing key id");
  let signatureValue: string;
  try {
    const privateKey = normalizePrivateKey(input.privateKey);
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key is not an Ed25519 private key");
    signatureValue = sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString("base64");
  } catch (error) {
    throw new ToolProviderArchiveError(`Tool Provider manifest could not be signed: ${errorMessage(error)}`);
  }
  const signature: ToolProviderSignature = { algorithm: "ed25519", keyId, value: signatureValue };
  const envelope: ToolProviderArchiveEnvelope = {
    format: TOOL_PROVIDER_ARCHIVE_FORMAT,
    schemaVersion: TOOL_PROVIDER_ARCHIVE_VERSION,
    manifest,
    signature,
    entries,
  };
  const envelopeBuffer = Buffer.from(canonicalJson(envelope));
  if (envelopeBuffer.byteLength > policy.maximumEnvelopeBytes) {
    throw new ToolProviderArchiveError(`Tool Provider archive envelope exceeds ${policy.maximumEnvelopeBytes} bytes`);
  }
  const archive = gzipSync(envelopeBuffer, { level: 9 });
  if (archive.byteLength > policy.maximumArchiveBytes) {
    throw new ToolProviderArchiveError(`Tool Provider archive exceeds ${policy.maximumArchiveBytes} compressed bytes`);
  }
  mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${archivePath}.staging-${process.pid}`;
  if (existsSync(temporaryPath)) throw new ToolProviderArchiveError(`Archive staging path already exists: ${temporaryPath}`);
  try {
    writeFileSync(temporaryPath, archive, { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, archivePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return {
    archivePath: realpathSync(archivePath),
    manifest,
    signature,
    package: packageInventory,
    archiveSha256: sha256(archive),
    archiveBytes: archive.byteLength,
  };
}

export function extractAndVerifyToolProviderArchive(input: {
  archivePath: string;
  stagingRoot: string;
  trustRoots: ReadonlyMap<string, KeyLike | string | Buffer>;
  policy?: ToolProviderArchivePolicy;
  onStagingCreated?: (packageRoot: string) => void;
}): ExtractedToolProviderArchive {
  const policy = validatePolicy(input.policy ?? DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY);
  const archivePath = realFile(input.archivePath, "Tool Provider archive");
  const compressedBytes = statSync(archivePath).size;
  if (compressedBytes > policy.maximumArchiveBytes) {
    throw new ToolProviderArchiveError(`Tool Provider archive exceeds ${policy.maximumArchiveBytes} compressed bytes`);
  }
  let envelopeBytes: Buffer;
  try {
    envelopeBytes = gunzipSync(readFileSync(archivePath), { maxOutputLength: policy.maximumEnvelopeBytes });
  } catch (error) {
    throw new ToolProviderArchiveError(`Tool Provider archive cannot be decompressed within policy: ${errorMessage(error)}`);
  }
  let value: unknown;
  try { value = JSON.parse(envelopeBytes.toString("utf8")); }
  catch { throw new ToolProviderArchiveError("Tool Provider archive envelope is not valid JSON"); }
  const envelope = validateEnvelope(value, input.trustRoots, policy);
  mkdirSync(resolve(input.stagingRoot), { recursive: true, mode: 0o700 });
  const stagingParent = realDirectory(input.stagingRoot, "Tool Provider archive staging root");
  const packageRoot = mkdtempSync(join(stagingParent, "provider-"));
  try {
    input.onStagingCreated?.(packageRoot);
    for (const entry of envelope.entries) {
      const target = join(packageRoot, ...entry.path.split("/"));
      assertInside(packageRoot, target, entry.path);
      if (entry.type === "directory") {
        mkdirSync(target, { mode: 0o700 });
        continue;
      }
      const bytes = decodeCanonicalBase64(entry.contentBase64, entry.path);
      writeFileSync(target, bytes, { flag: "wx", mode: entry.executable ? 0o500 : 0o400 });
    }
    const inventory = inspectToolProviderPackage(packageRoot, policy);
    if (inventory.digest !== envelope.manifest.artifact.packageSha256) {
      throw new ToolProviderArchiveError("Extracted Tool Provider package digest does not match the signed manifest");
    }
    const resolved = resolveToolProviderEntrypoint(envelope.manifest, packageRoot);
    const executableDigest = sha256(readFileSync(resolved.executable));
    if (executableDigest !== envelope.manifest.artifact.sha256) {
      throw new ToolProviderArchiveError("Extracted Tool Provider executable digest does not match the signed manifest");
    }
    return { packageRoot, manifest: envelope.manifest, signature: envelope.signature, package: inventory };
  } catch (error) {
    try { removeStagingPackage(stagingParent, packageRoot); }
    catch (cleanupError) {
      throw new Error(`Archive extraction failed: ${errorMessage(error)}; staging cleanup failed: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
}

export function removeExtractedToolProviderArchive(stagingRoot: string, packageRoot: string): void {
  const parent = realDirectory(stagingRoot, "Tool Provider archive staging root");
  removeStagingPackage(parent, packageRoot);
}

function validateEnvelope(
  value: unknown,
  trustRoots: ReadonlyMap<string, KeyLike | string | Buffer>,
  policy: ToolProviderArchivePolicy,
): ToolProviderArchiveEnvelope {
  const record = exactRecord(value, ["entries", "format", "manifest", "schemaVersion", "signature"], "Tool Provider archive envelope");
  if (record.format !== TOOL_PROVIDER_ARCHIVE_FORMAT || record.schemaVersion !== TOOL_PROVIDER_ARCHIVE_VERSION) {
    throw new ToolProviderArchiveError("Tool Provider archive format or schema version is incompatible");
  }
  const manifest = validateToolProviderManifest(record.manifest);
  const signature = validateToolProviderSignature(record.signature);
  const trustRoot = trustRoots.get(signature.keyId);
  if (!trustRoot) throw new ToolProviderArchiveError(`Unknown Tool Provider signing key ${signature.keyId}`);
  const signatureBytes = decodeCanonicalBase64(signature.value, "manifest signature");
  let verified = false;
  try {
    const publicKey = normalizePublicKey(trustRoot);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") throw new Error("trust root is not an Ed25519 public key");
    verified = verify(null, Buffer.from(canonicalJson(manifest)), publicKey, signatureBytes);
  }
  catch (error) { throw new ToolProviderArchiveError(`Tool Provider trust root is invalid: ${errorMessage(error)}`); }
  if (!verified) throw new ToolProviderArchiveError("Tool Provider manifest signature verification failed");
  if (!Array.isArray(record.entries) || !record.entries.length) {
    throw new ToolProviderArchiveError("Tool Provider archive requires package entries");
  }
  if (record.entries.length > policy.maximumEntries) {
    throw new ToolProviderArchiveError(`Tool Provider archive exceeds ${policy.maximumEntries} entries`);
  }
  const entries: ArchiveEntry[] = [];
  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  const directoryPaths = new Set<string>();
  let files = 0;
  let bytes = 0;
  let previousPath: string | null = null;
  for (const entryValue of record.entries) {
    const preliminary = requireRecord(entryValue, "Tool Provider archive entry");
    const path = portableRelativePath(preliminary.path, "archive entry path", policy.maximumPathBytes, false);
    if (previousPath !== null && comparePath(previousPath, path) >= 0) {
      throw new ToolProviderArchiveError("Tool Provider archive entries must be strictly sorted by path");
    }
    previousPath = path;
    const folded = path.toLocaleLowerCase("en-US");
    if (exactPaths.has(path) || foldedPaths.has(folded)) {
      throw new ToolProviderArchiveError(`Tool Provider archive contains duplicate path ${path}`);
    }
    exactPaths.add(path);
    foldedPaths.add(folded);
    const parent = parentPath(path);
    if (parent && !directoryPaths.has(parent)) {
      throw new ToolProviderArchiveError(`Tool Provider archive entry ${path} is missing its parent directory`);
    }
    if (preliminary.type === "directory") {
      exactRecord(entryValue, ["path", "type"], `archive directory ${path}`);
      entries.push({ path, type: "directory" });
      directoryPaths.add(path);
      continue;
    }
    if (preliminary.type !== "file") throw new ToolProviderArchiveError(`Tool Provider archive entry ${path} has unsupported type`);
    const file = exactRecord(entryValue, ["bytes", "contentBase64", "executable", "path", "sha256", "type"], `archive file ${path}`);
    if (!Number.isInteger(file.bytes) || Number(file.bytes) < 0) throw new ToolProviderArchiveError(`Archive file ${path} has invalid byte length`);
    if (typeof file.executable !== "boolean") throw new ToolProviderArchiveError(`Archive file ${path} has invalid executable flag`);
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new ToolProviderArchiveError(`Archive file ${path} has invalid SHA-256 digest`);
    }
    if (typeof file.contentBase64 !== "string") throw new ToolProviderArchiveError(`Archive file ${path} has invalid content`);
    const content = decodeCanonicalBase64(file.contentBase64, path);
    if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
      throw new ToolProviderArchiveError(`Archive file ${path} content does not match its declared digest and size`);
    }
    files += 1;
    bytes += content.byteLength;
    if (files > policy.maximumFiles) throw new ToolProviderArchiveError(`Tool Provider archive exceeds ${policy.maximumFiles} files`);
    if (bytes > policy.maximumBytes) throw new ToolProviderArchiveError(`Tool Provider archive exceeds ${policy.maximumBytes} package bytes`);
    entries.push({
      path,
      type: "file",
      bytes: content.byteLength,
      executable: file.executable,
      sha256: file.sha256,
      contentBase64: file.contentBase64,
    });
  }
  if (!files) throw new ToolProviderArchiveError("Tool Provider archive package cannot be empty");
  return { format: TOOL_PROVIDER_ARCHIVE_FORMAT, schemaVersion: TOOL_PROVIDER_ARCHIVE_VERSION, manifest, signature, entries };
}

function collectEntries(root: string, policy: ToolProviderArchivePolicy): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let files = 0;
  let bytes = 0;
  walk(root, "", (absolute, path, stats) => {
    portableRelativePath(path, "package entry path", policy.maximumPathBytes, false);
    if (stats.isDirectory()) {
      entries.push({ path, type: "directory" });
      return;
    }
    if (!stats.isFile()) throw new ToolProviderArchiveError(`Tool Provider package contains unsupported entry ${path}`);
    const content = readFileSync(absolute);
    files += 1;
    bytes += content.byteLength;
    if (files > policy.maximumFiles) throw new ToolProviderArchiveError(`Tool Provider package exceeds ${policy.maximumFiles} files`);
    if (bytes > policy.maximumBytes) throw new ToolProviderArchiveError(`Tool Provider package exceeds ${policy.maximumBytes} bytes`);
    entries.push({
      path,
      type: "file",
      bytes: content.byteLength,
      executable: (stats.mode & 0o111) !== 0,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    });
  });
  entries.sort((left, right) => comparePath(left.path, right.path));
  const foldedPaths = new Set<string>();
  for (const entry of entries) {
    const folded = entry.path.toLocaleLowerCase("en-US");
    if (foldedPaths.has(folded)) throw new ToolProviderArchiveError(`Tool Provider package contains a case-colliding path ${entry.path}`);
    foldedPaths.add(folded);
  }
  return entries;
}

function walk(root: string, relativeDirectory: string, visit: (absolute: string, path: string, stats: Stats) => void): void {
  const directory = relativeDirectory ? join(root, ...relativeDirectory.split("/")) : root;
  for (const name of readdirSync(directory).sort(comparePath)) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new ToolProviderArchiveError("Tool Provider package contains an invalid entry name");
    }
    const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    const absolute = join(directory, name);
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) throw new ToolProviderArchiveError(`Tool Provider package contains symbolic link ${path}`);
    visit(absolute, path, stats);
    if (stats.isDirectory()) walk(root, path, visit);
  }
}

function validatePolicy(policy: ToolProviderArchivePolicy): ToolProviderArchivePolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ToolProviderArchiveError(`Tool Provider archive policy ${name} must be a positive integer`);
  }
  return policy;
}

function portableRelativePath(value: unknown, label: string, maximumPathBytes: number, allowRoot: boolean): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\") || value.includes(":")) {
    throw new ToolProviderArchiveError(`${label} must be a portable relative path`);
  }
  if (Buffer.byteLength(value) > maximumPathBytes) throw new ToolProviderArchiveError(`${label} exceeds ${maximumPathBytes} bytes`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new ToolProviderArchiveError(`${label} escapes or ambiguously addresses the package root`);
  }
  if (!allowRoot && !segments.length) throw new ToolProviderArchiveError(`${label} must name a package entry`);
  return segments.join("/");
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ToolProviderArchiveError(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new ToolProviderArchiveError(`${label} is not canonical base64`);
  return bytes;
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort(comparePath);
  const expected = [...keys].sort(comparePath);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ToolProviderArchiveError(`${label} contains missing or unsupported fields`);
  }
  return record;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolProviderArchiveError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ToolProviderArchiveError(`${label} contains unsupported characters`);
  }
  return value;
}

function realDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new ToolProviderArchiveError(`${label} must be absolute`);
  try {
    const path = realpathSync(value);
    if (!statSync(path).isDirectory()) throw new Error("not a directory");
    return path;
  } catch (error) {
    throw new ToolProviderArchiveError(`${label} cannot be verified: ${errorMessage(error)}`);
  }
}

function realFile(value: string, label: string): string {
  if (!isAbsolute(value)) throw new ToolProviderArchiveError(`${label} path must be absolute`);
  try {
    const path = realpathSync(value);
    if (!statSync(path).isFile()) throw new Error("not a file");
    return path;
  } catch (error) {
    throw new ToolProviderArchiveError(`${label} cannot be verified: ${errorMessage(error)}`);
  }
}

function removeStagingPackage(parent: string, packageRoot: string): void {
  const target = resolve(packageRoot);
  const pathFromParent = relative(parent, target);
  if (!pathFromParent || pathFromParent === ".." || pathFromParent.startsWith(`..${sep}`) || isAbsolute(pathFromParent)
    || dirname(target) !== parent || !basename(target).startsWith("provider-")) {
    throw new ToolProviderArchiveError("Refusing to remove a staging package outside its staging root");
  }
  rmSync(target, { recursive: true, force: true });
}

function assertInside(root: string, target: string, label: string): void {
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new ToolProviderArchiveError(`Archive entry ${label} escapes its staging package`);
  }
}

function parentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index < 0 ? null : path.slice(0, index);
}

function normalizePrivateKey(value: KeyLike | string | Buffer): KeyObject {
  if (value instanceof KeyObject) return value;
  if (typeof value === "string" || Buffer.isBuffer(value)) return createPrivateKey(value);
  return KeyObject.from(value);
}

function normalizePublicKey(value: KeyLike | string | Buffer): KeyObject {
  if (value instanceof KeyObject) return value;
  if (typeof value === "string" || Buffer.isBuffer(value)) return createPublicKey(value);
  return KeyObject.from(value);
}

function comparePath(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
