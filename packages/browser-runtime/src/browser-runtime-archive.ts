import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, rm, symlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import {
  verifyBrowserRuntimeSourceArchiveHandle,
  type BrowserRuntimeSourceTarget,
} from "./browser-runtime-source-lock.js";

export interface ExtractBrowserRuntimeArchiveOptions {
  target: BrowserRuntimeSourceTarget;
  archivePath: string;
  destination: string;
  maximumEntries?: number;
  maximumExpandedBytes?: number;
  maximumFileBytes?: number;
}

export async function extractBrowserRuntimeSourceArchive(
  options: ExtractBrowserRuntimeArchiveOptions,
): Promise<{ browserRootPath: string; browserPath: string; entries: number; expandedBytes: number }> {
  if (!isAbsolute(options.destination)) throw new Error("Browser Runtime extraction destination must be absolute");
  const maximumEntries = options.maximumEntries ?? 100_000;
  const maximumExpandedBytes = options.maximumExpandedBytes ?? 4 * 1024 * 1024 * 1024;
  const maximumFileBytes = options.maximumFileBytes ?? 2 * 1024 * 1024 * 1024;
  if (![maximumEntries, maximumExpandedBytes, maximumFileBytes]
    .every((value) => Number.isSafeInteger(value) && value > 0)
    || maximumFileBytes > maximumExpandedBytes) {
    throw new Error("Browser Runtime extraction limits are invalid");
  }
  if (!isAbsolute(options.archivePath)) throw new Error("Browser Runtime source archive path must be absolute");
  const archive = await open(options.archivePath, "r");
  let destinationCreated = false;
  let zip: ZipFile;
  try {
    await verifyBrowserRuntimeSourceArchiveHandle({ target: options.target, archive });
    await mkdir(options.destination, { recursive: false, mode: 0o700 });
    destinationCreated = true;
    zip = await openZip(archive.fd);
  } catch (error) {
    if (destinationCreated) await rm(options.destination, { recursive: true, force: true });
    await archive.close();
    throw error;
  }
  const names = new Set<string>();
  const links: Array<{ path: string; target: string }> = [];
  let entries = 0;
  let expandedBytes = 0;
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      const name = safeEntryName(entry.fileName, options.target.rootDirectory);
      if (names.has(name)) throw new Error("Browser Runtime archive contains a duplicate path");
      names.add(name);
      entries += 1;
      if (entries > maximumEntries) throw new Error("Browser Runtime archive entry limit exceeded");
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      const directoryByName = entry.fileName.endsWith("/");
      const isDirectory = directoryByName || type === 0o040000;
      const isSymlink = type === 0o120000;
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        throw new Error("Browser Runtime archive contains an encrypted entry");
      }
      if ((directoryByName && type !== 0 && type !== 0o040000)
        || (type !== 0 && !isDirectory && !isSymlink && type !== 0o100000)) {
        throw new Error("Browser Runtime archive contains an unsupported entry type");
      }
      const outputPath = resolve(options.destination, name);
      assertInside(options.destination, outputPath);
      if (isDirectory) {
        if (entry.uncompressedSize !== 0) throw new Error("Browser Runtime archive directory contains data");
        await mkdir(outputPath, { recursive: true, mode: entryMode(entry, 0o755) });
        continue;
      }
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || entry.uncompressedSize > maximumFileBytes) {
        throw new Error("Browser Runtime archive file size is invalid");
      }
      expandedBytes += entry.uncompressedSize;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > maximumExpandedBytes) {
        throw new Error("Browser Runtime archive expanded byte limit exceeded");
      }
      await mkdir(resolve(outputPath, ".."), { recursive: true, mode: 0o755 });
      if (isSymlink) {
        const target = await readLinkTarget(zip, entry);
        validateLinkTarget(resolve(options.destination, options.target.rootDirectory), outputPath, target);
        links.push({ path: outputPath, target });
      } else {
        const stream = await openEntryStream(zip, entry);
        await pipeline(stream, createWriteStream(outputPath, { flags: "wx", mode: entryMode(entry, 0o644) }));
      }
    }
    for (const link of links) {
      if ([...names].some((name) => {
        const linkName = relative(options.destination, link.path).split(sep).join("/");
        return name.startsWith(linkName + "/");
      })) throw new Error("Browser Runtime archive places content below a symbolic link");
      await symlink(link.target, link.path);
    }
    const browserRootPath = resolve(options.destination, options.target.rootDirectory);
    const browserPath = resolve(browserRootPath, options.target.executable);
    assertInside(browserRootPath, browserPath);
    const [rootInfo, browserInfo] = await Promise.all([lstat(browserRootPath), lstat(browserPath)]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !browserInfo.isFile() || browserInfo.isSymbolicLink()) {
      throw new Error("Browser Runtime archive does not contain its reviewed executable layout");
    }
    await verifyBrowserRuntimeSourceArchiveHandle({ target: options.target, archive });
    if (options.target.platform !== "win32") await chmod(browserPath, browserInfo.mode | 0o500);
    return { browserRootPath, browserPath, entries, expandedBytes };
  } catch (error) {
    await rm(options.destination, { recursive: true, force: true });
    throw error;
  } finally {
    await archive.close();
  }
}

function openZip(fileDescriptor: number): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.fromFd(fileDescriptor, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zip) => error || !zip ? reject(error ?? new Error("Browser Runtime archive could not be opened")) : resolvePromise(zip));
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolvePromise, reject) => {
    const entry = (value: Entry) => { cleanup(); resolvePromise(value); };
    const end = () => { cleanup(); resolvePromise(null); };
    const error = (value: Error) => { cleanup(); reject(value); };
    const cleanup = () => {
      zip.off("entry", entry);
      zip.off("end", end);
      zip.off("error", error);
    };
    zip.once("entry", entry);
    zip.once("end", end);
    zip.once("error", error);
    zip.readEntry();
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, stream) =>
      error || !stream ? reject(error ?? new Error("Browser Runtime archive entry could not be read")) : resolvePromise(stream));
  });
}

async function readLinkTarget(zip: ZipFile, entry: Entry): Promise<string> {
  if (entry.uncompressedSize < 1 || entry.uncompressedSize > 4096) {
    throw new Error("Browser Runtime archive symbolic link target is invalid");
  }
  const stream = await openEntryStream(zip, entry);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 4096) throw new Error("Browser Runtime archive symbolic link target is too large");
    chunks.push(buffer);
  }
  const target = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (!target || target.includes("\0")) throw new Error("Browser Runtime archive symbolic link target is invalid");
  return target;
}

function safeEntryName(value: string, rootDirectory: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")
    || Buffer.byteLength(value) > 4096) throw new Error("Browser Runtime archive path is invalid");
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = normalized.split("/");
  if (parts.some((part) => !safePathPart(part))
    || (normalized !== rootDirectory && !normalized.startsWith(rootDirectory + "/"))) {
    throw new Error("Browser Runtime archive path is outside its reviewed root");
  }
  return normalized;
}

function safePathPart(value: string): boolean {
  const stem = value.split(".", 1)[0]!;
  return Boolean(value) && value !== "." && value !== ".." && !value.includes(":")
    && !/[. ]$/.test(value) && !/[\u0000-\u001f]/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
}

function validateLinkTarget(root: string, linkPath: string, target: string): void {
  const parts = target.split("/");
  if (isAbsolute(target) || target.includes("\\") || target.includes(":")
    || /[\u0000-\u001f]/.test(target) || parts.some((part) => !part
      || (part !== "." && part !== ".." && !safePathPart(part)))) {
    throw new Error("Browser Runtime archive contains an invalid symbolic link");
  }
  assertInside(root, resolve(linkPath, "..", target));
}

function assertInside(root: string, path: string): void {
  const value = relative(resolve(root), resolve(path));
  if (!value || value === ".." || value.startsWith(".." + sep) || isAbsolute(value)) {
    throw new Error("Browser Runtime archive path escapes its extraction root");
  }
}

function entryMode(entry: Entry, fallback: number): number {
  const mode = (entry.externalFileAttributes >>> 16) & 0o777;
  return mode || fallback;
}
