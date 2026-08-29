import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ToolProviderPackagePolicy {
  maximumFiles: number;
  maximumBytes: number;
}

export const DEFAULT_TOOL_PROVIDER_PACKAGE_POLICY: ToolProviderPackagePolicy = {
  maximumFiles: 10_000,
  maximumBytes: 256 * 1024 * 1024,
};

export interface ToolProviderPackageInventory {
  digest: string;
  files: number;
  bytes: number;
}

export class ManagedToolProviderPackageStore {
  readonly root: string;

  constructor(
    root: string,
    private readonly policy: ToolProviderPackagePolicy = DEFAULT_TOOL_PROVIDER_PACKAGE_POLICY,
  ) {
    if (!isAbsolute(root)) throw new Error("Managed Tool Provider package root must be absolute");
    if (!Number.isInteger(policy.maximumFiles) || policy.maximumFiles < 1
      || !Number.isInteger(policy.maximumBytes) || policy.maximumBytes < 1) {
      throw new Error("Managed Tool Provider package policy must use positive integer limits");
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
  }

  inspect(sourceRoot: string): ToolProviderPackageInventory {
    return inspectToolProviderPackage(sourceRoot, this.policy);
  }

  publish(sourceRoot: string, providerId: string, version: string, packageDigest: string): string {
    const source = realpathSync(sourceRoot);
    if (inside(this.root, source)) throw new Error("Tool Provider import source cannot be inside the managed package store");
    const inventory = this.inspect(source);
    if (inventory.digest !== packageDigest) throw new Error("Tool Provider package digest does not match the signed manifest");
    const providerRoot = join(this.root, providerId);
    mkdirSync(providerRoot, { recursive: true, mode: 0o700 });
    const target = join(providerRoot, `${version}-${packageDigest.slice(0, 16)}`);
    if (existsSync(target)) {
      const existing = this.inspect(target);
      if (existing.digest !== packageDigest) throw new Error("Managed Tool Provider package target contains conflicting content");
      return realpathSync(target);
    }
    const staging = join(providerRoot, `.staging-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      copyTree(source, staging, this.policy);
      const copied = this.inspect(staging);
      if (copied.digest !== packageDigest) throw new Error("Tool Provider package changed during atomic import");
      makeReadOnly(staging);
      try {
        renameSync(staging, target);
      } catch (error) {
        if (!existsSync(target)) throw error;
        const existing = this.inspect(target);
        if (existing.digest !== packageDigest) throw new Error("Managed Tool Provider package publication raced with conflicting content");
        removeTree(staging);
      }
      return realpathSync(target);
    } catch (error) {
      removeTree(staging);
      throw error;
    }
  }

  collect(packageRoot: string): { reclaimedBytes: number } {
    const target = resolve(packageRoot);
    if (target === this.root || !inside(this.root, target)) throw new Error("Tool Provider package collection target escapes the managed root");
    if (!existsSync(target)) return { reclaimedBytes: 0 };
    const rootStats = lstatSync(target);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error("Tool Provider package collection target must be a managed directory without symbolic links");
    let reclaimedBytes = 0;
    walk(target, "", (_absolute, _relativePath, stats) => {
      if (stats.isFile()) reclaimedBytes += stats.size;
    });
    removeTree(target);
    return { reclaimedBytes };
  }
}

export function inspectToolProviderPackage(
  rootValue: string,
  policy: ToolProviderPackagePolicy = DEFAULT_TOOL_PROVIDER_PACKAGE_POLICY,
): ToolProviderPackageInventory {
  const root = realpathSync(rootValue);
  if (!lstatSync(root).isDirectory()) throw new Error("Tool Provider package source must be a directory");
  const entries: Array<{ path: string; type: "directory" | "file"; bytes: number; executable: boolean; digest: string }> = [];
  let files = 0;
  let totalBytes = 0;
  walk(root, "", (absolute, relativePath, stats) => {
    if (stats.isDirectory()) {
      entries.push({ path: relativePath, type: "directory", bytes: 0, executable: true, digest: "" });
      return;
    }
    if (!stats.isFile()) throw new Error(`Tool Provider package contains unsupported entry ${relativePath}`);
    const bytes = stats.size;
    const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    entries.push({ path: relativePath, type: "file", bytes, executable: (stats.mode & 0o111) !== 0, digest });
    files += 1;
    totalBytes += bytes;
    if (files > policy.maximumFiles) throw new Error(`Tool Provider package exceeds ${policy.maximumFiles} files`);
    if (totalBytes > policy.maximumBytes) throw new Error(`Tool Provider package exceeds ${policy.maximumBytes} bytes`);
  });
  if (!files) throw new Error("Tool Provider package cannot be empty");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${Buffer.byteLength(entry.path)}:${entry.path}:${entry.type}:${entry.bytes}:${entry.executable ? 1 : 0}:${entry.digest}\n`);
  }
  return { digest: hash.digest("hex"), files, bytes: totalBytes };
}

function copyTree(sourceRoot: string, targetRoot: string, policy: ToolProviderPackagePolicy): void {
  let files = 0;
  let bytes = 0;
  walk(sourceRoot, "", (absolute, relativePath, stats) => {
    const target = join(targetRoot, ...relativePath.split("/"));
    if (stats.isDirectory()) {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      return;
    }
    if (!stats.isFile()) throw new Error(`Tool Provider package contains unsupported entry ${relativePath}`);
    files += 1;
    bytes += stats.size;
    if (files > policy.maximumFiles || bytes > policy.maximumBytes) throw new Error("Tool Provider package exceeds import limits");
    mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
    copyFileSync(absolute, target);
    chmodSync(target, stats.mode & 0o111 ? 0o500 : 0o400);
  });
}

function walk(
  root: string,
  relativeDirectory: string,
  visit: (absolute: string, relativePath: string, stats: Stats) => void,
): void {
  const directory = relativeDirectory ? join(root, ...relativeDirectory.split("/")) : root;
  for (const name of readdirSync(directory).sort()) {
    if (name === "." || name === ".." || basename(name) !== name) throw new Error("Tool Provider package contains an invalid entry name");
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    const absolute = join(directory, name);
    const stats = lstatSync(absolute) as Stats;
    if (stats.isSymbolicLink()) throw new Error(`Tool Provider package contains symbolic link ${relativePath}`);
    if (stats.isDirectory()) {
      visit(absolute, relativePath, stats);
      walk(root, relativePath, visit);
    } else visit(absolute, relativePath, stats);
  }
}

function makeReadOnly(root: string): void {
  const directories: string[] = [root];
  walk(root, "", (absolute, _relativePath, stats) => {
    if (stats.isDirectory()) directories.push(absolute);
    else if (stats.isFile()) chmodSync(absolute, stats.mode & 0o111 ? 0o500 : 0o400);
  });
  for (const directory of [...new Set(directories)].sort((left, right) => right.length - left.length)) chmodSync(directory, 0o500);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function removeTree(root: string): void {
  if (!existsSync(root)) return;
  try {
    walk(root, "", (absolute, _relativePath, stats) => chmodSync(absolute, stats.isDirectory() ? 0o700 : 0o600));
    chmodSync(root, 0o700);
  } catch {
    // rmSync below reports the actionable cleanup failure.
  }
  rmSync(root, { recursive: true, force: true });
}
