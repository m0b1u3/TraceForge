import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createSignedToolProviderArchive } from "../apps/server/src/tool-provider-archive.js";

const flags = parseFlags(process.argv.slice(2));
const sourceRoot = resolve(required(flags, "source"));
const manifestPath = realFile(required(flags, "manifest"), "manifest");
const privateKeyPath = realPrivateKey(required(flags, "private-key"));
const archivePath = resolve(required(flags, "output"));
const keyId = required(flags, "key-id");

let manifestValue: unknown;
try { manifestValue = JSON.parse(readFileSync(manifestPath, "utf8")); }
catch (error) { throw new Error(`Cannot read Tool Provider manifest JSON: ${message(error)}`); }

const result = createSignedToolProviderArchive({
  sourceRoot,
  manifestValue,
  privateKey: readFileSync(privateKeyPath),
  keyId,
  archivePath,
});

console.log(JSON.stringify({
  archivePath: result.archivePath,
  archiveSha256: result.archiveSha256,
  archiveBytes: result.archiveBytes,
  providerId: result.manifest.providerId,
  version: result.manifest.version,
  packageSha256: result.package.digest,
  signerId: result.signature.keyId,
}, null, 2));

function parseFlags(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Usage: provider:publish --source PATH --manifest FILE --private-key FILE --key-id ID --output FILE.tfpa");
    }
    const key = name.slice(2);
    if (values.has(key)) throw new Error(`Duplicate option --${key}`);
    values.set(key, value);
  }
  const supported = new Set(["source", "manifest", "private-key", "key-id", "output"]);
  for (const key of values.keys()) if (!supported.has(key)) throw new Error(`Unsupported option --${key}`);
  return values;
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

function realFile(value: string, label: string): string {
  const path = realpathSync(resolve(value));
  const stats = lstatSync(path);
  if (!stats.isFile()) throw new Error(`Tool Provider ${label} must be a regular file`);
  return path;
}

function realPrivateKey(value: string): string {
  const unresolved = resolve(value);
  if (lstatSync(unresolved).isSymbolicLink()) throw new Error("Tool Provider private key cannot be a symbolic link");
  const path = realFile(unresolved, "private key");
  const mode = lstatSync(path).mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error("Tool Provider private key must not be accessible by group or other users");
  }
  return path;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
