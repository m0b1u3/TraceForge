import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { StorageLayout } from "./storage-layout.js";

async function size(root: string): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0, complete = true;
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) { complete = false; continue; }
      if (entry.isDirectory()) pending.push(...(await readdir(path)).map(name => join(path, name)));
      else if (entry.isFile()) bytes += entry.size;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false; }
  }
  return { bytes, complete };
}

export function createStorageBridge(options: { layout: StorageLayout; webContentsId: number; origin: string;
  open(path: string): Promise<string>; cache: { getCacheSize(): Promise<number>; clearCache(): Promise<void> };
  diagnostics: { readonly available: boolean; record(event: "cache_cleared" | "cache_clear_failed"): void } }) {
  let busy = false, closed = false;
  return { close() { closed = true; }, async request(sender: { webContentsId: number; mainFrame: boolean; url: string }, operation: unknown) {
    if (closed || sender.webContentsId !== options.webContentsId || !sender.mainFrame || sender.url !== `${options.origin}/`) throw new Error("Invalid storage sender");
    if (!["inspect", "open-data", "open-logs", "clear-cache"].includes(operation as string)) throw new Error("Invalid storage operation");
    if (busy) throw new Error("Storage operation in progress");
    busy = true;
    try {
      if (operation === "inspect") {
        const [data, logs, cacheBytes] = await Promise.all([size(options.layout.root), size(options.layout.logs), options.cache.getCacheSize()]);
        return { ...options.layout, data, logsUsage: logs, cacheBytes, diagnosticsAvailable: options.diagnostics.available };
      }
      if (operation === "clear-cache") {
        try { await options.cache.clearCache(); options.diagnostics.record("cache_cleared"); }
        catch { options.diagnostics.record("cache_clear_failed"); throw new Error("Cache cleanup failed"); }
        return { cleared: true };
      }
      const error = await options.open(operation === "open-data" ? options.layout.root : options.layout.logs);
      if (error) throw new Error("Unable to open directory");
      return { opened: true };
    } finally { busy = false; }
  } };
}
