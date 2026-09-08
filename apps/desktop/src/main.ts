import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from "electron";
import { requireDesktopRenderer } from "./renderer-availability.js";
import { ModelAccounts, ModelAccountManifestSchema, defaultModelAccounts } from "@traceforge/server/model-settings";
import { createModelTokenStore } from "./model-token-store.js";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildServer, foundationHostControl, type LlmSecretBundle, type LlmSecretStore } from "@traceforge/server";
import { ensureDesktopData, resolveDesktopPaths } from "./desktop-paths.js";
import { createConversationBridge } from "./conversation-bridge.js";
import { createModelSettingsBridge } from "./model-settings-bridge.js";

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
  const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : resolve(moduleDirectory, "../../web/renderer/dist");
  requireDesktopRenderer(webRoot);
  if (process.platform === "darwin" && app.isPackaged) {
    const helperRoot = join(process.resourcesPath, "native", "darwin-arm64");
    process.env.TRACEFORGE_MACOS_SANDBOX_HELPER = join(helperRoot, "traceforge-macos-sandbox");
    process.env.TRACEFORGE_NATIVE_HELPER_RELEASE_MANIFEST = join(helperRoot, "release.json");
    process.env.TRACEFORGE_REQUIRE_NATIVE_HELPER_RELEASE_MANIFEST = "1";
  }
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
  const manifestPath = join(paths.configDirectory, "model-accounts.json");
  if (existsSync(manifestPath) && statSync(manifestPath).size > 65536) throw new Error("Account manifest exceeds limit");
  const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
  if (manifestText && Buffer.byteLength(manifestText) > 65536) throw new Error("Account manifest exceeds limit");
  const accounts = new ModelAccounts(manifestText ? ModelAccountManifestSchema.parse(JSON.parse(manifestText)) : defaultModelAccounts(),
    createModelTokenStore(join(paths.configDirectory, "model-tokens.bin"), {
      available: () => safeStorage.isEncryptionAvailable() && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
      encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
    }));
  server = await buildServer(paths.database, paths.mcpConfig, paths.llmConfig, paths.root, webRoot, {
    llmSecretStore: desktopLlmSecretStore(paths.llmSecrets),
    modelAccounts: accounts,
    browserInstallationPath: process.env.TRACEFORGE_BROWSER_INSTALLATION,
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
      preload: join(moduleDirectory, "preload.cjs"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const conversationBridge = createConversationBridge({
    webContentsId: mainWindow.webContents.id, origin: localOrigin,
    host: { request: async input => {
      if (!server) throw new Error("Desktop host unavailable");
      const response = await server.inject({ method: input.method, url: input.path,
        ...(input.body === undefined ? {} : { payload: input.body }),
        headers: { ...managementChannel.headers(), ...(input.body === undefined ? {} : { "content-type": "application/json" }) },
      });
      return { status: response.statusCode, body: response.json() };
    } },
  });
  ipcMain.handle("conversations:request", (event, input: unknown) => conversationBridge.request({
    webContentsId: event.sender.id, mainFrame: event.senderFrame === event.sender.mainFrame,
    url: event.senderFrame?.url ?? "",
  }, input));
  const modelBridge = createModelSettingsBridge({ origin: localOrigin, webContentsId: mainWindow.webContents.id,
    async openLogin(id) {
      const url = new URL(accounts.authorizationUrl(id));
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid authorization URL");
      await shell.openExternal(url.href);
    },
    request: async (url, payload) => {
      if (!server) throw new Error("Desktop host unavailable");
      const response = await server.inject({ url, method: payload === undefined ? "GET" : "POST", ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
        headers: { ...managementChannel.headers(), ...(payload === undefined ? {} : { "content-type": "application/json" }) } });
      return { status: response.statusCode, body: response.json() };
    } });
  ipcMain.handle("models:request", (event, input: unknown) => modelBridge.request({
    webContentsId: event.sender.id, mainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? "",
  }, input));
  mainWindow.on("closed", () => { modelBridge.close(); ipcMain.removeHandler("models:request"); });
  mainWindow.on("closed", () => { conversationBridge.close(); ipcMain.removeHandler("conversations:request"); });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const destination = new URL(url);
    if (destination.origin !== localOrigin || destination.pathname !== "/") { event.preventDefault(); }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  await mainWindow.loadURL(`http://127.0.0.1:${address.port}`);
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
