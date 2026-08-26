import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("traceforgeDesktop", {
  platform: process.platform,
  version: process.env.npm_package_version ?? "unknown",
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateState: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("updates:state", handler);
    return () => ipcRenderer.removeListener("updates:state", handler);
  },
});
