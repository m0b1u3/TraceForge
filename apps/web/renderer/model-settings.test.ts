// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { ModelSettings } from "./model-settings";
import type { ModelSettingsBridge, ModelSettingsSnapshot } from "./model-settings-client";

let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); vi.useRealTimers(); document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear(); });
async function render(bridge?: ModelSettingsBridge) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => { root.render(React.createElement(ModelSettings, { bridge })); });
  const field = (name: string) => node.querySelector(`[aria-label="${name}"]`) as HTMLInputElement;
  const change = async (name: string, value: string) => { await act(async () => { const element = field(name); element.value = value; Simulate.change(element); }); };
  const click = async (name: string) => { await act(async () => { [...node.querySelectorAll("button")].find(button => button.textContent === name)!.click(); }); };
  return { node, field, change, click };
}
const initial: ModelSettingsSnapshot = { configured: false, config: null, revision: "a".repeat(64), scope: "host",
  suppliers: { deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com", jsonMode: "json_object" }, xai: { protocol: "openai", baseUrl: "https://api.x.ai/v1", jsonMode: "json_schema" } } };

it("automatically loads the sole logged-in account's directory, selects and preserves manual fallback", async () => {
  vi.useFakeTimers(); let fail = false; const calls: string[] = [];
  const snapshot: ModelSettingsSnapshot = { ...initial, accounts: [{ id: "first", label: "First", provider: "responses", baseUrl: "https://models.example/v1", issuer: "https://identity.example", scopes: ["api"], status: "connected" }] };
  const ui = await render({ protocolVersion: 1, request: async input => {
    calls.push(input.operation);
    if (input.operation === "discover") {
      expect((input.payload as { config: Record<string, unknown> }).config).toMatchObject({ credentialRef: "first", model: "" });
      return fail ? { status: 503, body: { error: "unsupported", raw: "secret" } } : { status: 200, body: { models: [{ id: "first-model" }, { id: "second-model" }], truncated: false } };
    }
    return { status: 200, body: snapshot };
  } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(ui.field("认证连接").value).toBe("first"); expect(ui.node.textContent).toContain("获取到 2 个模型");
  expect(ui.field("模型 ID").value).toBe("");
  await ui.change("选择模型", "second-model"); expect(ui.field("模型 ID").value).toBe("second-model");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(calls.filter(value => value === "discover")).toHaveLength(1);
  await ui.change("模型 ID", ""); fail = true; await ui.click("刷新模型列表");
  expect(ui.node.textContent).toContain("此端点未提供标准模型目录"); expect(ui.node.textContent).not.toContain("secret");
  await ui.change("模型 ID", "manual-model"); expect(ui.field("模型 ID").value).toBe("manual-model");
  expect(calls).not.toContain("test"); expect(calls).not.toContain("save");
});

it("completes supplier selection, unsaved test, save, masked reload and endpoint key isolation", async () => {
  let snapshot = structuredClone(initial); const calls: Array<{ operation: string; payload?: unknown }> = [];
  const ui = await render({ protocolVersion: 1, request: async input => {
    calls.push(input);
    if (input.operation === "test") return { status: 200, body: { ok: true, saved: false, scope: "structured_ping" } };
    if (input.operation === "save") {
      const { apiKey: _key, ...safe } = (input.payload as { config: Record<string, unknown> }).config;
      snapshot = { ...snapshot, configured: true, revision: "b".repeat(64), config: { ...safe, apiKeyMasked: "••••••••" } as NonNullable<ModelSettingsSnapshot["config"]> };
    }
    return { status: 200, body: snapshot };
  } });
  await ui.change("供应商", "deepseek"); expect(ui.field("API 地址").value).toBe("https://api.deepseek.com");
  await ui.change("模型 ID", "chosen-model"); await ui.change("API 密钥", "fixture-ui-secret");
  await ui.click("测试连接"); expect(ui.node.textContent).toContain("当前表单未保存");
  expect(calls.filter(call => call.operation === "save")).toHaveLength(0);
  await act(async () => { Simulate.submit(ui.node.querySelector("form")!); });
  expect(ui.node.textContent).toContain("已保存到安全存储"); expect(ui.field("API 密钥").value).toBe("");
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  await ui.change("API 地址", "https://second.example/v1"); await ui.click("测试连接");
  expect(ui.node.textContent).toContain("更换端点后必须重新输入密钥");
  expect(calls.filter(call => call.operation === "test")).toHaveLength(1);
});

it("never accepts keys or sends requests in browser-only preview", async () => {
  const ui = await render();
  expect(ui.field("API 密钥").disabled).toBe(true);
  expect(ui.node.textContent).toContain("未连接桌面安全存储");
  expect([...ui.node.querySelectorAll("button")].filter(button => ["测试连接", "保存配置"].includes(button.textContent ?? "")).every(button => button.disabled)).toBe(true);
});

it("switches wire protocol without discarding supplier/endpoint and clears entered credentials", async () => {
  const ui = await render({ protocolVersion: 1, request: async () => ({ status: 200, body: initial }) });
  await ui.change("供应商", "xai"); await ui.change("API 密钥", "fixture-secret");
  await ui.change("接口协议", "responses");
  expect(ui.field("供应商").value).toBe("xai");
  expect(ui.field("API 地址").value).toBe("https://api.x.ai/v1");
  expect(ui.field("接口协议").value).toBe("responses");
  expect(ui.field("API 密钥").value).toBe("");
});

it("handles conflicts with reload, clears entered secrets and does not echo raw errors", async () => {
  const ui = await render({ protocolVersion: 1, request: async input => input.operation === "load" ? { status: 200, body: initial } : { status: 409, body: { error: "raw-secret-should-not-render" } } });
  await ui.change("供应商", "deepseek"); await ui.change("模型 ID", "m"); await ui.change("API 密钥", "temporary-secret");
  await act(async () => { Simulate.submit(ui.node.querySelector("form")!); });
  expect(ui.node.textContent).toContain("配置已被其他操作改变");
  expect(ui.node.textContent).not.toContain("raw-secret"); expect(ui.field("API 密钥").value).toBe("");
  expect(ui.field("API 密钥").disabled).toBe(true);
  await ui.click("重新读取"); expect(ui.node.textContent).toContain("丢弃当前未保存");
  await ui.click("放弃修改并读取"); expect(ui.field("API 密钥").disabled).toBe(false);
});

it("completes account login, connection selection, saving and confirmed logout without browser secrets", async () => {
  let snapshot: ModelSettingsSnapshot = { ...structuredClone(initial), accounts: [{ id: "first", label: "First account", provider: "responses",
    issuer: "https://identity.example", scopes: ["api"], baseUrl: "https://model.example/v1", status: "signed_out" }] };
  const calls: Array<{ operation: string; payload?: unknown }> = [];
  const ui = await render({ protocolVersion: 1, request: async input => {
    calls.push(input);
    if (input.operation === "account") {
      const operation = (input.payload as { operation: string }).operation;
      if (operation === "begin") return { status: 200, body: { state: "pending", login: { userCode: "public-code", verificationUrl: "https://identity.example/activate", expiresAt: Date.now() + 600000, intervalMs: 1000 } } };
      snapshot = { ...snapshot, accounts: snapshot.accounts!.map(account => ({ ...account, status: operation === "poll" ? "connected" : "signed_out" })) };
      return { status: 200, body: { state: operation === "poll" ? "connected" : "signed_out" } };
    }
    if (input.operation === "save") {
      const config = (input.payload as { config: NonNullable<ModelSettingsSnapshot["config"]> }).config;
      expect(config).not.toHaveProperty("apiKey"); expect(config.credentialRef).toBe("first");
      snapshot = { ...snapshot, configured: true, config: { ...config, apiKeyMasked: "" }, revision: "b".repeat(64) };
    }
    return { status: 200, body: snapshot };
  } });
  await ui.click("登录账号"); expect(ui.node.textContent).toContain("public-code");
  await ui.click("检查登录"); expect(ui.node.textContent).toContain("账号已登录");
  await ui.change("认证连接", "first"); await ui.change("模型 ID", "selected-model");
  expect(ui.field("API 密钥").disabled).toBe(true); expect(ui.field("API 地址").disabled).toBe(true);
  await act(async () => { Simulate.submit(ui.node.querySelector("form")!); });
  expect(ui.node.textContent).toContain("已保存到安全存储");
  await ui.click("退出账号"); expect(calls.filter(call => (call.payload as { operation?: string })?.operation === "disconnect")).toHaveLength(0);
  await ui.click("确认退出"); expect(ui.node.textContent).toContain("已移除该账号凭据");
  expect([...ui.node.querySelectorAll("button")].find(button => button.textContent === "测试连接")!.disabled).toBe(true);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});
