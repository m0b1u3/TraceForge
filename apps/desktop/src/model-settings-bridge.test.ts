import { expect, it, vi } from "vitest";
import { createModelSettingsBridge } from "./model-settings-bridge.js";

it("opens login by registered account reference only, never a renderer URL", async () => {
  const openLogin = vi.fn(async (_id: string) => {});
  const request = vi.fn(async () => ({ status: 200, body: {} }));
  const bridge = createModelSettingsBridge({ origin: "http://127.0.0.1:4000", webContentsId: 1, request, openLogin });
  const sender = { webContentsId: 1, mainFrame: true, url: "http://127.0.0.1:4000/" };
  expect(await bridge.request(sender, { operation: "open-login", payload: { id: "account" } })).toEqual({ status: 200, body: { opened: true } });
  expect(openLogin).toHaveBeenCalledExactlyOnceWith("account"); expect(request).not.toHaveBeenCalled();
  for (const payload of [{ id: "account", url: "https://other.example" }, { id: "https://other.example" }, { url: "https://other.example" }]) {
    await expect(bridge.request(sender, { operation: "open-login", payload })).rejects.toThrow();
  }
  await expect(bridge.request({ ...sender, mainFrame: false }, { operation: "open-login", payload: { id: "account" } })).rejects.toThrow();
  bridge.close(); await expect(bridge.request(sender, { operation: "open-login", payload: { id: "account" } })).rejects.toThrow();
  expect(openLogin).toHaveBeenCalledTimes(1);
});
