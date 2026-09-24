import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { buildModelSettingsHost, ModelAccountManifestSchema, defaultModelAccounts } from "@traceforge/server/model-settings";
import { createModelTokenStore } from "./model-token-store.js";
import { createModelSettingsBridge } from "./model-settings-bridge.js";
import { ensureDesktopData, resolveDesktopPaths } from "./desktop-paths.js";
import { configureDesktopStorage } from "./storage-bootstrap.js";

configureDesktopStorage();

// Explicit settings-only development entry: no Core, Scenario, conversation
// dispatch, model probe on boot, updater, or production release fence override.
let host: Awaited<ReturnType<typeof buildModelSettingsHost>> | undefined;
let window: BrowserWindow | undefined;
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { window?.show(); window?.focus(); });
app.whenReady().then(async () => {
  const paths = resolveDesktopPaths(app.getPath("userData")); ensureDesktopData(paths);
  const secure = () => {
    if (!safeStorage.isEncryptionAvailable() || process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") throw new Error("Secure credential storage unavailable");
  };
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  // An explicit installation manifest replaces compatibility defaults.
  // No third-party account files are imported; malformed manifests fail closed.
  const manifestPath = join(paths.configDirectory, "model-accounts.json");
  if (existsSync(manifestPath) && statSync(manifestPath).size > 65536) throw new Error("Account manifest exceeds limit");
  const manifest = existsSync(manifestPath)
    ? ModelAccountManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8"))) : defaultModelAccounts();
  const tokenStore = createModelTokenStore(join(paths.configDirectory, "model-tokens.bin"), {
    available() { try { secure(); return true; } catch { return false; } },
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
  });
  host = await buildModelSettingsHost(resolve(moduleDirectory, "../../web/renderer/dist"), paths.llmConfig, {
    load() { if (!existsSync(paths.llmSecrets)) return { alternativeRoutes: {} }; secure(); return JSON.parse(safeStorage.decryptString(readFileSync(paths.llmSecrets))); },
    save(secrets) { secure(); const temporary = `${paths.llmSecrets}.${process.pid}.tmp`; writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 }); renameSync(temporary, paths.llmSecrets); },
  }, { manifest, store: tokenStore });
  await host.web.listen({ host: "127.0.0.1", port: 0 });
  const address = host.web.server.address(); if (!address || typeof address === "string") throw new Error("Settings host unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  window = new BrowserWindow({ width: 960, height: 960, minWidth: 640, minHeight: 600, backgroundColor: "#ffffff", show: false,
    webPreferences: { preload: join(moduleDirectory, "preload.cjs"), additionalArguments: ["--traceforge-model-settings"], contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  const bridge = createModelSettingsBridge({ origin, webContentsId: window.webContents.id, request: (url, payload) => host!.request(url, payload),
    async openLogin(id) {
      const url = new URL(host!.authorizationUrl(id));
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid authorization URL");
      await shell.openExternal(url.href);
    } });
  ipcMain.handle("models:request", (event, value: unknown) => bridge.request({ webContentsId: event.sender.id, mainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? "" }, value));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== origin || new URL(url).pathname !== "/") event.preventDefault(); });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => { bridge.close(); ipcMain.removeHandler("models:request"); window = undefined; void host?.close().finally(() => app.quit()); });
  await window.loadURL(`${origin}/`);
}).catch(() => { console.error("模型设置窗口无法启动；请检查构建与系统安全存储。"); app.exit(1); });
app.on("window-all-closed", () => app.quit());
