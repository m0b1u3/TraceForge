const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("embeddedReview", {
  initialize: () => ipcRenderer.invoke("fixture:initialize"),
  present: (input: unknown) => ipcRenderer.invoke("fixture:present", input),
  command: (input: unknown) => ipcRenderer.invoke("fixture:command", input),
});
