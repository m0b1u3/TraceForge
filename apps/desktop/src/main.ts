import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildServer, foundationHostControl, type LlmSecretBundle, type LlmSecretStore } from "@traceforge/server";
import { ensureDesktopData, resolveDesktopPaths } from "./desktop-paths.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let server: FastifyInstance | null = null;
let quitting = false;

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function emitUpdateState(state: Record<string, unknown>): void {
  mainWindow?.webContents.send("updates:state", state);
}

function configureUpdates(): void {
  autoUpdater.autoDownload = false;
  // A downloaded release must be installed explicitly; quitting alone must not
  // switch the native helper generation before the operator sees readiness.
  autoUpdater.autoInstallOnAppQuit = false;
  const updateUrl = process.env.TRACEFORGE_UPDATE_URL?.trim();
  if (updateUrl) autoUpdater.setFeedURL({ provider: "generic", url: updateUrl });
  autoUpdater.on("checking-for-update", () => emitUpdateState({ status: "checking" }));
  autoUpdater.on("update-available", (info) => emitUpdateState({ status: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => emitUpdateState({ status: "current" }));
  autoUpdater.on("download-progress", (progress) => emitUpdateState({ status: "downloading", percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => emitUpdateState({ status: "ready", version: info.version }));
  autoUpdater.on("error", (error) => emitUpdateState({ status: "error", message: error.message }));
  ipcMain.handle("updates:check", async () => app.isPackaged ? autoUpdater.checkForUpdates() : { updateInfo: { version: app.getVersion() } });
  ipcMain.handle("updates:download", async () => autoUpdater.downloadUpdate());
  ipcMain.handle("updates:install", () => { autoUpdater.quitAndInstall(false, true); return true; });
}

function desktopLlmSecretStore(path: string): LlmSecretStore {
  const requireEncryption = () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Operating-system secret encryption is unavailable");
    if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
      throw new Error("A Linux secret store such as Secret Service/KWallet is required for model credentials");
    }
  };
  return {
    load() {
      if (!existsSync(path)) return { alternativeRoutes: {} };
      requireEncryption();
      return JSON.parse(safeStorage.decryptString(readFileSync(path))) as LlmSecretBundle;
    },
    save(secrets) {
      requireEncryption();
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}

async function start(): Promise<void> {
  if (process.platform === "win32" && app.isPackaged) {
    const helperRoot = join(process.resourcesPath, "native", "win32-x64");
    process.env.TRACEFORGE_WINDOWS_SANDBOX_HELPER = join(helperRoot, "traceforge-windows-sandbox.exe");
    process.env.TRACEFORGE_NATIVE_HELPER_RELEASE_MANIFEST = join(helperRoot, "release.json");
    process.env.TRACEFORGE_REQUIRE_NATIVE_HELPER_RELEASE_MANIFEST = "1";
  }
  const paths = resolveDesktopPaths(app.getPath("userData"));
  if (process.platform === "linux" && app.isPackaged) {
    // Linux process readiness is granted only by the DEB-installed systemd
    // launcher. Portable/direct launches intentionally leave the capability
    // unavailable instead of treating a bundled helper as deployment proof.
    const deploymentMode = process.env.TRACEFORGE_LINUX_DEPLOYMENT_MODE?.trim();
    if (deploymentMode === "systemd-user-delegated-v1") {
      process.env.TRACEFORGE_LINUX_SANDBOX_HELPER = "/usr/lib/traceforge/traceforge-linux-sandbox";
      process.env.TRACEFORGE_NATIVE_HELPER_RELEASE_MANIFEST = "/usr/lib/traceforge/release.json";
      process.env.TRACEFORGE_REQUIRE_NATIVE_HELPER_RELEASE_MANIFEST = "1";
      delete process.env.TRACEFORGE_LINUX_DEPLOYMENT_STATUS;
    } else {
      delete process.env.TRACEFORGE_LINUX_SANDBOX_HELPER;
      delete process.env.TRACEFORGE_NATIVE_HELPER_RELEASE_MANIFEST;
      delete process.env.TRACEFORGE_LINUX_CGROUP_ROOT;
      delete process.env.TRACEFORGE_LINUX_SANDBOX_SCRATCH_ROOT;
      process.env.TRACEFORGE_REQUIRE_NATIVE_HELPER_RELEASE_MANIFEST = "1";
      process.env.TRACEFORGE_LINUX_DEPLOYMENT_STATUS = "portable_or_direct_launch";
    }
  }
  ensureDesktopData(paths);
  const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : resolve(moduleDirectory, "../../web/dist");
  server = await buildServer(paths.database, paths.mcpConfig, paths.llmConfig, paths.root, webRoot, {
    llmSecretStore: desktopLlmSecretStore(paths.llmSecrets),
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("desktop server did not bind a TCP port");
  const managementChannel = foundationHostControl(server).management();
  const localOrigin = `http://127.0.0.1:${address.port}`;
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
    const requestUrl = new URL(details.url);
    const localApi = requestUrl.origin === localOrigin && requestUrl.pathname.startsWith("/api/");
    const localWebSocket = requestUrl.protocol === "ws:" && requestUrl.hostname === "127.0.0.1"
      && requestUrl.port === String(address.port) && requestUrl.pathname === "/ws";
    callback({ requestHeaders: localApi || localWebSocket
      ? { ...details.requestHeaders, Authorization: managementChannel.headers().authorization }
      : details.requestHeaders });
  });

  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 700,
    show: false, backgroundColor: "#11100e",
    webPreferences: {
      preload: join(moduleDirectory, "preload.js"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(localOrigin)) { event.preventDefault(); if (/^https?:\/\//i.test(url)) void shell.openExternal(url); }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  await mainWindow.loadURL(`http://127.0.0.1:${address.port}`);
  configureUpdates();
  if (app.isPackaged) void autoUpdater.checkForUpdates().catch(() => undefined);
}

app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox("TraceForge failed to start", error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});

app.on("activate", () => { if (mainWindow) mainWindow.show(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  void server.close().finally(() => { server = null; app.quit(); });
});
