import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { storageLayout } from "./storage-layout.js";
import { createDiagnostics } from "./desktop-diagnostics.js";
import { createStorageBridge } from "./desktop-storage.js";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "traceforge-storage-test-")); roots.push(root);
  const input = { appData: root, home: root, current: join(root, "@traceforge/desktop"), appName: "@traceforge/desktop", packaged: false, platform: "darwin" };
  return { root, input };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("separates stable production, development and isolated roots", () => {
  const { root, input } = fixture();
  expect(storageLayout(input)).toMatchObject({ root: join(root, "TraceForge-Dev"), logs: join(root, "Library/Logs/TraceForge-Dev"), cache: join(root, "Library/Caches/TraceForge-Dev"), channel: "development" });
  expect(storageLayout({ ...input, packaged: true })).toMatchObject({ root: join(root, "TraceForge"), channel: "production" });
  expect(storageLayout({ ...input, current: join(root, "isolated") })).toMatchObject({ root: join(root, "isolated"), logs: join(root, "isolated/logs"), channel: "isolated" });
});
it("retains legacy records and credentials in place, refuses ambiguous stores", () => {
  const { root, input } = fixture(); mkdirSync(join(input.current, "config"), { recursive: true });
  writeFileSync(join(input.current, "config/llm-secrets.bin"), "encrypted fixture");
  expect(storageLayout(input)).toMatchObject({ root: input.current, legacy: true });
  expect(readFileSync(join(input.current, "config/llm-secrets.bin"), "utf8")).toBe("encrypted fixture");
  mkdirSync(join(root, "TraceForge-Dev")); writeFileSync(join(root, "TraceForge-Dev/traceforge.sqlite"), "other");
  expect(() => storageLayout(input)).toThrow("两个独立");
  expect(storageLayout({ ...input, packaged: true }).root).toBe(join(root, "TraceForge"));
});
it("adopts an old Electron development profile only when it contains TraceForge data", () => {
  const { root, input } = fixture(); const current = join(root, "Electron"); mkdirSync(current);
  expect(storageLayout({ ...input, current, appName: "Electron" }).legacy).toBe(false);
  writeFileSync(join(current, "traceforge.sqlite"), "fixture");
  expect(storageLayout({ ...input, current, appName: "Electron" }).root).toBe(current);
});
it("never adopts the production root when a development launcher has the production app name", () => {
  const { root, input } = fixture(); const current = join(root, "TraceForge"); mkdirSync(current); writeFileSync(join(current, "traceforge.sqlite"), "production");
  expect(storageLayout({ ...input, current, appName: "TraceForge" })).toMatchObject({ root: join(root, "TraceForge-Dev"), legacy: false, channel: "development" });
});
it("rotates only owned diagnostic files, excludes raw content and survives write failures", () => {
  const { root } = fixture(); const directory = join(root, "logs"); const logger = createDiagnostics(directory, 100);
  for (let i = 0; i < 30; i++) logger.stream.write(JSON.stringify({ level: 30, msg: "private prompt", req: { headers: { authorization: "secret" }, url: "private" }, err: { message: "secret" }, res: { statusCode: 200 } }));
  expect(readdirSync(directory).length).toBeLessThanOrEqual(6);
  const text = readdirSync(directory).map(name => readFileSync(join(directory, name), "utf8")).join("");
  expect(text).not.toMatch(/private|secret|authorization/); expect(text).toContain('"status":200');
  logger.stream.write("unstructured secret"); expect(logger.available).toBe(true);
  const invalid = createDiagnostics(join(root, "file")); writeFileSync(join(root, "file"), "file");
  expect(() => invalid.record("started")).not.toThrow(); expect(invalid.available).toBe(false);
});
it("rejects symlink log destinations without overwriting outside data", () => {
  const { root } = fixture(); mkdirSync(join(root, "logs")); writeFileSync(join(root, "keep"), "keep"); symlinkSync(join(root, "keep"), join(root, "logs/desktop.jsonl"));
  const log = createDiagnostics(join(root, "logs")); log.record("started");
  expect(log.available).toBe(false); expect(readFileSync(join(root, "keep"), "utf8")).toBe("keep");
});
it("binds storage IPC to the main frame and fixed operations; cache clearing never deletes profile data", async () => {
  const { root, input } = fixture(); const layout = storageLayout({ ...input, current: join(root, "isolated") });
  mkdirSync(layout.root); mkdirSync(layout.logs); writeFileSync(join(layout.root, "traceforge.sqlite"), "keep");
  symlinkSync(root, join(layout.root, "outside"));
  const cache = { getCacheSize: vi.fn(async () => 123), clearCache: vi.fn(async () => {}) }, open = vi.fn(async () => "");
  const bridge = createStorageBridge({ layout, webContentsId: 1, origin: "http://localhost:1234", open, cache, diagnostics: createDiagnostics(layout.logs) });
  const sender = { webContentsId: 1, mainFrame: true, url: "http://localhost:1234/" };
  await expect(bridge.request({ ...sender, mainFrame: false }, "clear-cache")).rejects.toThrow();
  await expect(bridge.request(sender, { operation: "open", path: root })).rejects.toThrow();
  expect(await bridge.request(sender, "inspect")).toMatchObject({ cacheBytes: 123, data: { complete: false } });
  await bridge.request(sender, "open-data"); expect(open).toHaveBeenCalledWith(layout.root);
  await bridge.request(sender, "clear-cache"); expect(cache.clearCache).toHaveBeenCalledOnce();
  expect(readFileSync(join(layout.root, "traceforge.sqlite"), "utf8")).toBe("keep");
  bridge.close(); await expect(bridge.request(sender, "inspect")).rejects.toThrow();
});
it("serializes cache operations and reports failures without retrying", async () => {
  const { input } = fixture(); let reject!: (e: Error) => void;
  const clearCache = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  const bridge = createStorageBridge({ layout: storageLayout(input), webContentsId: 1, origin: "http://localhost", open: async () => "", cache: { getCacheSize: async () => 0, clearCache }, diagnostics: { available: true, record() {} } });
  const sender = { webContentsId: 1, mainFrame: true, url: "http://localhost/" };
  const pending = bridge.request(sender, "clear-cache");
  await expect(bridge.request(sender, "clear-cache")).rejects.toThrow("in progress");
  reject(new Error("secret failure")); await expect(pending).rejects.toThrow("Cache cleanup failed"); expect(clearCache).toHaveBeenCalledOnce();
});
