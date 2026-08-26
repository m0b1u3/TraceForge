import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildServer } from "@traceforge/server";
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
  autoUpdater.autoInstallOnAppQuit = true;
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

async function start(): Promise<void> {
  if (process.platform === "win32" && app.isPackaged) {
    process.env.TRACEFORGE_WINDOWS_SANDBOX_HELPER = join(
      process.resourcesPath,
      "native",
      "win32-x64",
      "traceforge-windows-sandbox.exe",
    );
  }
  const paths = resolveDesktopPaths(app.getPath("userData"));
  ensureDesktopData(paths);
  const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : resolve(moduleDirectory, "../../web/dist");
  server = await buildServer(paths.database, paths.mcpConfig, paths.llmConfig, paths.root, webRoot);
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("desktop server did not bind a TCP port");

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
    const localOrigin = `http://127.0.0.1:${address.port}`;
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
