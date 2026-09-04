import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface BrowserRuntimeTreeMeasurement {
  sha256: string;
  entries: number;
  bytes: number;
}

export async function measureBrowserRuntimeTree(rootPath: string, limits: {
  maximumEntries?: number;
  maximumBytes?: number;
} = {}): Promise<BrowserRuntimeTreeMeasurement> {
  if (!isAbsolute(rootPath)) throw new Error("Browser Runtime tree root must be absolute");
  const maximumEntries = limits.maximumEntries ?? 100_000;
  const maximumBytes = limits.maximumBytes ?? 4 * 1024 * 1024 * 1024;
  if (![maximumEntries, maximumBytes].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Browser Runtime tree limits are invalid");
  }
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Browser Runtime tree root must be a real directory");
  }
  const canonicalRoot = await realpath(rootPath);
  const entries: Array<{
    path: string;
    kind: "directory" | "file" | "symlink";
    mode: number;
    bytes: number;
    digest: string;
  }> = [];
  const pending = [rootPath];
  let totalBytes = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const fullPath = resolve(directory, entry.name);
      const relativePath = normalizeRelative(rootPath, fullPath);
      const info = await lstat(fullPath);
      if (entries.length >= maximumEntries) throw new Error("Browser Runtime tree entry limit exceeded");
      if (info.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory", mode: info.mode & 0o777, bytes: 0, digest: "" });
        pending.push(fullPath);
      } else if (info.isFile()) {
        totalBytes += info.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
          throw new Error("Browser Runtime tree byte limit exceeded");
        }
        entries.push({
          path: relativePath,
          kind: "file",
          mode: info.mode & 0o777,
          bytes: info.size,
          digest: await stableFileSha256(fullPath, info),
        });
      } else if (info.isSymbolicLink()) {
        const target = await readlink(fullPath);
        if (isAbsolute(target)) throw new Error("Browser Runtime tree contains an absolute symbolic link");
        const resolvedTarget = resolve(dirname(fullPath), target);
        assertInsideRoot(rootPath, resolvedTarget);
        assertInsideRoot(canonicalRoot, await realpath(resolvedTarget));
        entries.push({
          path: relativePath,
          kind: "symlink",
          mode: info.mode & 0o777,
          bytes: Buffer.byteLength(target),
          digest: createHash("sha256").update(target, "utf8").digest("hex"),
        });
      } else throw new Error("Browser Runtime tree contains an unsupported filesystem entry");
    }
  }
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(JSON.stringify(entry)).update("\n");
  return { sha256: hash.digest("hex"), entries: entries.length, bytes: totalBytes };
}

function normalizeRelative(rootPath: string, path: string): string {
  assertInsideRoot(rootPath, path);
  const value = relative(rootPath, path).split(sep).join("/");
  if (!value || isAbsolute(value) || value.includes("\0")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Browser Runtime tree contains an unsafe path");
  }
  return value;
}

function assertInsideRoot(rootPath: string, path: string): void {
  const value = relative(resolve(rootPath), resolve(path));
  if (!value || value === ".." || value.startsWith(".." + sep) || isAbsolute(value)) {
    throw new Error("Browser Runtime path escapes its reviewed installation root");
  }
}

async function stableFileSha256(path: string, before: Awaited<ReturnType<typeof stat>>): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Browser Runtime file changed while being measured");
  }
  return hash.digest("hex");
}
