const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("traceforgeDesktop", {
  platform: process.platform,
  mode: process.argv.includes("--traceforge-model-settings") ? "model-settings" : "workbench",
  version: process.env.npm_package_version ?? "unknown",
  modelSettings: {
    protocolVersion: 1,
    request: (input: { operation: "load" | "save" | "test" | "account" | "open-login" | "discover"; payload?: unknown }) => ipcRenderer.invoke("models:request", input),
  },
  conversations: {
    protocolVersion: 1,
    request: (input: { path: string; method: "GET" | "POST"; body?: string }) => ipcRenderer.invoke("conversations:request", input),
  },
});
