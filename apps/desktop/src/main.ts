import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { DesktopJournalStore } from "./desktop-journal-store.js";
import { RequestScheduler } from "./request-scheduler.js";
import { requireDesktopRenderer } from "./renderer-availability.js";
import { ModelAccounts, ModelAccountManifestSchema, defaultModelAccounts } from "@traceforge/server/model-settings";
import { createModelTokenStore } from "./model-token-store.js";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildServer, foundationHostControl, loadBundledScenarios, type LlmSecretBundle, type LlmSecretStore } from "@traceforge/server";
import { ensureDesktopData, resolveDesktopPaths } from "./desktop-paths.js";
import { createConversationBridge } from "./conversation-bridge.js";
import { createModelSettingsBridge } from "./model-settings-bridge.js";
import {readSelectedAttachment} from "./attachment-file.js";
import {MessageAttachmentsSchema} from "@traceforge/shared/message-attachments";
import { EmbeddedBrowser } from "./embedded-browser.js";
import { configureDesktopStorage } from "./storage-bootstrap.js";
import { createDiagnostics } from "./desktop-diagnostics.js";
import { createStorageBridge } from "./desktop-storage.js";

const storageLayout = configureDesktopStorage();
const diagnostics = createDiagnostics(storageLayout.logs);

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let server: FastifyInstance | null = null;
let quitting = false;
let createWindow: (() => Promise<void>) | undefined;
let opening: Promise<void> | undefined;
const embeddedBrowser = new EmbeddedBrowser();
function showWindow() {
  if (quitting) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus(); return;
  }
  if (!opening && createWindow) opening = createWindow().catch(error => {
    dialog.showErrorBox("TraceForge window unavailable", error instanceof Error ? error.message : String(error));
  }).finally(() => { opening = undefined; });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

app.on("second-instance", () => {
  showWindow();
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
  diagnostics.record("started");
  const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : resolve(moduleDirectory, "../../web/renderer/dist");
  requireDesktopRenderer(webRoot);
  if (process.platform === "darwin") {
    const helperRoot = app.isPackaged ? join(process.resourcesPath, "native", "darwin-arm64") : resolve(moduleDirectory,"../../../packages/execution-node/native/darwin-arm64");
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
  const desktopJournal = new DesktopJournalStore(join(paths.root, "desktop-journal.json"));
  const manifestPath = join(paths.configDirectory, "model-accounts.json");
  if (existsSync(manifestPath) && statSync(manifestPath).size > 65536) throw new Error("Account manifest exceeds limit");
  const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
  if (manifestText && Buffer.byteLength(manifestText) > 65536) throw new Error("Account manifest exceeds limit");
  const accounts = new ModelAccounts(manifestText ? ModelAccountManifestSchema.parse(JSON.parse(manifestText)) : defaultModelAccounts(),
    createModelTokenStore(join(paths.configDirectory, "model-tokens.bin"), {
      available: () => safeStorage.isEncryptionAvailable() && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
      encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
    }));
  const mcpSecrets = createModelTokenStore(join(paths.configDirectory,"mcp-secrets.bin"), {
    available: () => safeStorage.isEncryptionAvailable() && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value),
  }, 2048);
  server = await buildServer(paths.database, paths.mcpConfig, paths.llmConfig, paths.root, webRoot, {
    desktopTaskPreferences:()=>desktopJournal.request({operation:"get",key:"traceforge.desktop.task-preferences.v1"}),
    ...(process.platform==="darwin"&&process.arch==="arm64"?{bundledScenarioConfiguration:loadBundledScenarios(app.isPackaged?join(process.resourcesPath,"scenarios"):resolve(moduleDirectory,"../bundled-scenarios"),process.env.TRACEFORGE_MACOS_SANDBOX_HELPER!)}:{}),
    // The desktop owns its local HTTP server; incomplete requests must not
    // prevent Quit. Lifecycle hooks still persist interruption and stop work.
    closeActiveConnections:true,
    diagnosticStream: diagnostics.stream,
    publishReplyDelta: event => {
      const window = mainWindow;
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed() &&
          [localOrigin, `${localOrigin}/`].includes(window.webContents.getURL()))
        window.webContents.send("conversations:reply-delta", event);
    },
    desktopResources: { secrets: { async read(ref) { return (await mcpSecrets.read(ref))?.accessToken; },
      async write(ref,value) { await mcpSecrets.write(ref,{accessToken:value,binding:ref,expiresAt:8640000000000000}); } } },
    desktopMcp: { secrets: { async read(ref) { return (await mcpSecrets.read(ref))?.accessToken; },
      async write(ref,value) { await mcpSecrets.write(ref,{accessToken:value,binding:ref,expiresAt:8640000000000000}); } } },
    llmSecretStore: desktopLlmSecretStore(paths.llmSecrets),
    continuationCipher:{encrypt(value){if(!safeStorage.isEncryptionAvailable() || process.platform==="linux"&&safeStorage.getSelectedStorageBackend()==="basic_text")throw new Error("Secure storage unavailable");return safeStorage.encryptString(value);},decrypt:value=>safeStorage.decryptString(value)},
    modelAccounts: accounts,
    embeddedBrowser: artifacts => embeddedBrowser.deployment(artifacts),
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("desktop server did not bind a TCP port");
  const managementChannel = foundationHostControl(server).management();
  const localOrigin = `http://127.0.0.1:${address.port}`;
  // Renderer HTTP/WebSocket requests never receive host credentials. Only the
  // validated IPC handlers below can use the in-memory management channel.
  createWindow = async () => {
  if (quitting || mainWindow && !mainWindow.isDestroyed()) return;
  const scheduler = new RequestScheduler();
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 700,
    show: false, backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(moduleDirectory, "preload.cjs"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  const window = mainWindow;
  const journalHandler = (event: Electron.IpcMainEvent, input: unknown) => {
    try {
      if (event.sender.id !== window.webContents.id || event.senderFrame !== event.sender.mainFrame
        || new URL(event.senderFrame?.url ?? "").origin !== localOrigin) throw new Error("Invalid journal sender");
      event.returnValue = { ok: true, value: desktopJournal.request(input) };
    } catch { event.returnValue = { ok: false }; }
  };
  ipcMain.on("desktop-journal:request", journalHandler);
  let selectingAttachments=false;
  ipcMain.handle("attachments:select",async(event)=>{
    if(event.sender.id!==window.webContents.id||event.senderFrame!==event.sender.mainFrame||new URL(event.senderFrame?.url??"").origin!==localOrigin||selectingAttachments)throw new Error("Invalid attachment request");
    selectingAttachments=true;
    try{
      const selected=await dialog.showOpenDialog(window,{title:"添加附件（PDF / 文本 32 MiB，图片 / 音频 1 MiB）",properties:["openFile","multiSelections"],filters:[{name:"支持的附件",extensions:["pdf","txt","md","json","csv","log","yaml","yml","xml","html","css","js","ts","py","sh","png","jpg","jpeg","wav","mp3"]}]});
      if(selected.canceled)return [];
      if(selected.filePaths.length>4)throw new Error("Too many attachments");
      const items=[];
      for(const path of selected.filePaths){
        if(window.isDestroyed()||!server)throw new Error("Host closed");
        const payload=await readSelectedAttachment(path);
        const extension=payload.name.split(".").at(-1)?.toLowerCase()??"";
        const media:Record<string,string>={png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",wav:"audio/wav",mp3:"audio/mpeg"};
        if(media[extension]){items.push(...MessageAttachmentsSchema.parse([{kind:extension==="wav"||extension==="mp3"?"audio":"image",name:payload.name,mediaType:media[extension],data:payload.data}]));continue;}
        const response=await server.inject({method:"POST",url:"/api/desktop/attachment-import",payload,headers:managementChannel.headers()});
        if(response.statusCode!==200)throw new Error("Attachment import failed");
        items.push(response.json());
      }
      return MessageAttachmentsSchema.parse(items);
    }finally{selectingAttachments=false;}
  });
  window.on("closed",()=>ipcMain.removeHandler("attachments:select"));
  window.on("closed", () => ipcMain.removeListener("desktop-journal:request", journalHandler));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const conversationBridge = createConversationBridge({
    scheduler,
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
  const storage = createStorageBridge({ layout: storageLayout, webContentsId: window.webContents.id, origin: localOrigin,
    open: path => shell.openPath(path), cache: window.webContents.session, diagnostics });
  ipcMain.handle("storage:request", (event, input: unknown) => storage.request({ webContentsId: event.sender.id,
    mainFrame: event.senderFrame === event.sender.mainFrame, url: event.senderFrame?.url ?? "" }, input));
  window.on("closed", () => { storage.close(); ipcMain.removeHandler("storage:request"); });
  window.webContents.on("render-process-gone", () => diagnostics.record("renderer_gone"));
  ipcMain.handle("browser:present", async (event, input: unknown) => {
    if (event.sender.id !== window.webContents.id || event.senderFrame !== event.sender.mainFrame
      || new URL(event.senderFrame?.url ?? "").origin !== localOrigin) throw new Error("Invalid browser view sender");
    if (!input || typeof input !== "object") throw new Error("Invalid browser view request");
    const value = input as { path?: unknown; sessionId?: unknown; takeoverId?: unknown; bounds?: unknown; hide?: unknown; focus?: unknown };
    if (value.hide === true) { embeddedBrowser.hide(); return { hidden: true }; }
    if (typeof value.path !== "string" || !/^\/api\/desktop\/conversations\/[\w-]+\/execution\/[\w-]+\/browser$/.test(value.path)
      || typeof value.sessionId !== "string" || (value.takeoverId!==null&&typeof value.takeoverId !== "string") || !value.bounds || typeof value.bounds !== "object") throw new Error("Invalid browser view request");
    const response = await conversationBridge.request({ webContentsId: event.sender.id, mainFrame: true, url: event.senderFrame!.url }, { path: value.path, method: "GET" });
    const sessions = (response.body as { sessions?: Array<{ id: string; status: string; takeoverId: string | null }> }).sessions;
    if (response.status !== 200 || !sessions?.some(s => s.id === value.sessionId && (value.takeoverId===null?s.status==="active":s.status === "manual_control" && s.takeoverId === value.takeoverId))) {
      embeddedBrowser.hide(); throw new Error("Browser ownership is no longer current");
    }
    return embeddedBrowser.show(window, value.sessionId, value.takeoverId, value.bounds as { x: number; y: number; width: number; height: number }, value.focus === true);
  });
  window.on("hide", () => embeddedBrowser.hide());
  window.webContents.on("render-process-gone", () => embeddedBrowser.hide());
  window.on("closed", () => { embeddedBrowser.hide(); ipcMain.removeHandler("browser:present"); });
  const modelBridge = createModelSettingsBridge({ origin: localOrigin, webContentsId: mainWindow.webContents.id,
    async openLogin(id) {
      const url = new URL(accounts.authorizationUrl(id));
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid authorization URL");
      await shell.openExternal(url.href);
    },
    request: async (url, payload) => {
      if (!server) throw new Error("Desktop host unavailable");
      const response = await scheduler.schedule(payload !== undefined, () => {
        if (!server) throw new Error("Desktop host unavailable");
        return server.inject({ url, method: payload === undefined ? "GET" : "POST", ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
        headers: { ...managementChannel.headers(), ...(payload === undefined ? {} : { "content-type": "application/json" }) } });
      }, payload === undefined ? url : undefined);
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
  mainWindow.once("ready-to-show", () => { if (!window.isDestroyed() && !quitting) window.show(); });
  // macOS closes the window, not the application. Retain the window and its
  // drafts/IPC while hidden; Dock activation restores it without another Server.
  mainWindow.on("close", event => {
    if (process.platform === "darwin" && !quitting) { event.preventDefault(); mainWindow?.hide(); }
  });
  mainWindow.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  try { await window.loadURL(localOrigin); }
  catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
  };
  await createWindow();
  diagnostics.record("ready");
}

app.whenReady().then(() => { if (hasLock) return start(); }).catch((error) => {
  diagnostics.record("startup_failed");
  dialog.showErrorBox("TraceForge failed to start", error instanceof Error ? error.stack ?? error.message : String(error));
  app.exit(1);
});

app.on("activate", showWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", (event) => {
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  diagnostics.record("shutdown");
  void server.close().catch(() => { diagnostics.record("cleanup_failed"); })
    .then(() => embeddedBrowser.shutdown())
    .catch(() => { diagnostics.record("cleanup_failed"); })
    .finally(() => { server = null; app.quit(); });
});
