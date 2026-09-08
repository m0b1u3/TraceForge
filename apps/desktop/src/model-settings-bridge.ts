import type { BridgeSender } from "./conversation-bridge.js";

export interface ModelSettingsRequest { operation: "load" | "save" | "test" | "account" | "open-login" | "discover"; payload?: unknown }
export function createModelSettingsBridge(options: { origin: string; webContentsId: number;
  openLogin?(id: string): Promise<void>;
  request(path: string, payload?: unknown): Promise<{ status: number; body: unknown }> }) {
  let active = true; let busy = false;
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password) throw new Error("Invalid model bridge origin");
  return { close() { active = false; }, async request(sender: BridgeSender, value: unknown) {
    let url: URL;
    try { url = new URL(sender.url); } catch { throw new Error("Untrusted model settings sender"); }
    if (!active || !sender.mainFrame || sender.webContentsId !== options.webContentsId || url.origin !== origin.origin || url.pathname !== "/" || url.username || url.password) throw new Error("Untrusted model settings sender");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model operation");
    const input = value as ModelSettingsRequest;
    if (Object.keys(input).some(key => !["operation", "payload"].includes(key)) || !["load", "save", "test", "account", "open-login", "discover"].includes(input.operation) ||
      (input.operation === "load" && input.payload !== undefined) ||
      (input.operation !== "load" && (input.payload === undefined || input.payload === null)) || JSON.stringify(input).length > 20000) throw new Error("Invalid model operation");
    if (busy) throw new Error("Model settings operation already running");
    busy = true;
    try {
      if (input.operation === "open-login") {
        const payload = input.payload as { id?: unknown };
        if (!options.openLogin || !payload || Object.keys(payload).length !== 1 || typeof payload.id !== "string" || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(payload.id)) throw new Error("Invalid login operation");
        await options.openLogin(payload.id);
        return { status: 200, body: { opened: true } };
      }
      const response = await options.request(`/api/desktop/models${input.operation === "load" ? "" : `/${input.operation}`}`, input.payload);
      if (!active) throw new Error("Model settings bridge closed");
      return response;
    } finally { busy = false; }
  } };
}
