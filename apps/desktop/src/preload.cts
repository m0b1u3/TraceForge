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
    subscribeReplyDelta: (listener: (event: { conversationId: string; messageId: string; kind: "text" | "reasoning"; offset: number; delta: string }) => void) => {
      if (typeof listener !== "function") throw new Error("Invalid reply listener");
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (!value || typeof value !== "object") return;
        const reply = value as Record<string, unknown>;
        if (typeof reply.conversationId === "string" && typeof reply.messageId === "string" &&
            (reply.kind === "text" || reply.kind === "reasoning") &&
            Number.isSafeInteger(reply.offset) && (reply.offset as number) >= 0 && typeof reply.delta === "string")
          listener(reply as { conversationId: string; messageId: string; kind: "text" | "reasoning"; offset: number; delta: string });
      };
      ipcRenderer.on("conversations:reply-delta", receive);
      return () => ipcRenderer.removeListener("conversations:reply-delta", receive);
    },
    selectAttachments: () => ipcRenderer.invoke("attachments:select"),
    storage: (operation: "inspect" | "open-data" | "open-logs" | "clear-cache") => ipcRenderer.invoke("storage:request", operation),
    presentBrowser: (input: unknown) => ipcRenderer.invoke("browser:present", input),
    request: (input: { path: string; method: "GET" | "POST"; body?: string }) => ipcRenderer.invoke("conversations:request", input),
  },
});
