import { app, BrowserWindow, ipcMain } from "electron";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { configureDesktopStorage } from "../apps/desktop/dist/storage-bootstrap.js";
import { createStorageBridge } from "../apps/desktop/dist/desktop-storage.js";
import { createDiagnostics } from "../apps/desktop/dist/desktop-diagnostics.js";

const root = mkdtempSync(join(tmpdir(), "traceforge-storage-native-"));
app.setPath("userData", root);
const layout = configureDesktopStorage();
assert.equal(layout.channel, "isolated"); assert.equal(layout.root, root);
const diagnostics = createDiagnostics(layout.logs);
let window, server;
async function verify() {
try {
  await app.whenReady();
  server = createServer((_, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>TraceForge isolated storage test</title><p>Local fixture</p>"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, webPreferences: { preload: resolve("apps/desktop/dist/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  assert.equal(window.webContents.session.getStoragePath(), root);
  const opened = [];
  const bridge = createStorageBridge({ layout, origin, webContentsId: window.webContents.id, cache: window.webContents.session, diagnostics, open: async path => { opened.push(path); return ""; } });
  ipcMain.handle("storage:request", (event, input) => bridge.request({ webContentsId: event.sender.id, mainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? "" }, input));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "traceforge.sqlite"), "fixture-records");
  writeFileSync(join(root, "config/llm-secrets.bin"), "fixture-encrypted-placeholder");
  await window.loadURL(origin);
  await window.webContents.session.cookies.set({ url: origin, name: "fixture-session", value: "keep" });
  const inspect = await window.webContents.executeJavaScript('window.traceforgeDesktop.conversations.storage("inspect")');
  assert.equal(inspect.root, root); assert.equal(inspect.channel, "isolated");
  await window.webContents.executeJavaScript('window.traceforgeDesktop.conversations.storage("open-data")');
  assert.deepEqual(opened, [root]);
  await window.webContents.executeJavaScript('window.traceforgeDesktop.conversations.storage("clear-cache")');
  assert.equal((await window.webContents.session.cookies.get({ name: "fixture-session" }))[0]?.value, "keep");
  assert.equal(readFileSync(join(root, "traceforge.sqlite"), "utf8"), "fixture-records");
  assert.equal(readFileSync(join(root, "config/llm-secrets.bin"), "utf8"), "fixture-encrypted-placeholder");
  assert.match(readFileSync(join(layout.logs, "desktop.jsonl"), "utf8"), /cache_cleared/);
  assert.equal(await window.webContents.executeJavaScript('window.traceforgeDesktop.conversations.storage({operation:"open",path:"/"}).then(()=>false,()=>true)'), true);
  console.log("PASS native preload IPC, isolated paths, cache API, preserved cookies/config/records, fixed-path operations");
  console.log(`Isolated fixture retained at ${root}`);
} catch (error) { console.error(error); process.exitCode = 1; }
finally { ipcMain.removeHandler("storage:request"); window?.destroy(); await new Promise(resolve => server ? server.close(resolve) : resolve()); app.exit(process.exitCode ?? 0); }
}
void verify();
