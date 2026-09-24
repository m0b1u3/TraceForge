// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StorageSettings } from "./storage-settings";
const snapshot = { root: "/data/TraceForge", logs: "/logs/TraceForge", cache: "/cache/TraceForge", channel: "development", legacy: true, data: { bytes: 100, complete: true }, logsUsage: { bytes: 10, complete: true }, cacheBytes: 50, diagnosticsAvailable: true };
let dispose: () => void;
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); });
async function render(storage?: ReturnType<typeof vi.fn>) {
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(<StorageSettings bridge={{ protocolVersion: 1, request: vi.fn(), storage }} />));
  return { node, click: async (name: string) => { await act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === name)!.click()); } };
}
it("reads usage without cleaning, opens fixed directories and clears cache only on click", async () => {
  const storage = vi.fn(async (operation: string) => operation === "inspect" ? snapshot : {}); const f = await render(storage);
  expect(storage.mock.calls).toEqual([["inspect"]]); expect(f.node.textContent).toContain("原有数据目录");
  await f.click("打开数据目录"); expect(storage).toHaveBeenLastCalledWith("open-data");
  await f.click("清理界面缓存"); expect(storage.mock.calls.map(call => call[0])).toEqual(["inspect", "open-data", "clear-cache", "inspect"]);
  expect(f.node.querySelector('[role="status"]')?.textContent).toContain("登录状态均已保留");
});
it("explains unavailable desktop bridge without fake success", async () => {
  const f = await render(); expect(f.node.textContent).toContain("桌面应用"); expect(f.node.querySelector("button")).toBeNull();
});
it("distinguishes completed cleanup from a failed usage refresh", async () => {
  let reads = 0;
  const storage = vi.fn(async (operation: string) => { if (operation === "inspect") { if (reads++) throw new Error("offline"); return snapshot; } return {}; });
  const f = await render(storage); await f.click("清理界面缓存");
  expect(f.node.querySelector('[role="status"]')?.textContent).toContain("缓存已清理");
  expect(f.node.querySelector('[role="alert"]')?.textContent).toContain("用量未能刷新");
  expect(f.node.textContent).not.toContain("未能确认缓存清理结果");
  expect(storage.mock.calls.filter(call => call[0] === "clear-cache")).toHaveLength(1);
});
it("preserves previous usage and exposes retry after failure without automatic mutation", async () => {
  const storage = vi.fn(async (operation: string) => { if (operation !== "inspect") throw new Error("private"); return snapshot; });
  const f = await render(storage); await f.click("清理界面缓存");
  expect(f.node.querySelector('[role="alert"]')?.textContent).toContain("未能确认"); expect(f.node.textContent).toContain(snapshot.root); expect(f.node.textContent).not.toContain("private");
  expect(storage).toHaveBeenCalledTimes(2);
});
