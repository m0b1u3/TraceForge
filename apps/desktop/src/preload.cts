const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
function journal(operation: "get" | "set" | "remove", key: string, value?: string) {
  const result = ipcRenderer.sendSync("desktop-journal:request", { operation, key, ...(value === undefined ? {} : { value }) });
  if (!result?.ok) throw new Error("Desktop state could not be saved or restored");
  return result.value as string | null;
}

contextBridge.exposeInMainWorld("traceforgeDesktop", {
  platform: process.platform,
  mode: process.argv.includes("--traceforge-model-settings") ? "model-settings" : "workbench",
  version: process.env.npm_package_version ?? "unknown",
  localState: {
    getItem: (key: string) => journal("get", key),
    setItem: (key: string, value: string) => { journal("set", key, value); },
    removeItem: (key: string) => { journal("remove", key); },
  },
  modelSettings: {
    protocolVersion: 1,
    request: (input: { operation: "load" | "save" | "test" | "account" | "open-login" | "discover"; payload?: unknown }) => ipcRenderer.invoke("models:request", input),
  },
  conversations: {
    protocolVersion: 1,
    selectAttachments: () => ipcRenderer.invoke("attachments:select"),
    presentBrowser: (input: unknown) => ipcRenderer.invoke("browser:present", input),
    request: (input: { path: string; method: "GET" | "POST"; body?: string }) => ipcRenderer.invoke("conversations:request", input),
  },
});
