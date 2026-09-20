// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { ConfigurationSettings } from "./configuration-settings";
import type { ConfigurationSnapshot } from "@traceforge/shared/desktop-configuration";
let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); });
it("edits, saves, restores with confirmation and keeps drafts on save failure", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let state: ConfigurationSnapshot = { packages: [{ package: { id: "neutral", version: "1", schemaRevision: 1 }, title: "Neutral", revision: 0,
    resources: [{ id: "first", type: "skill", summary: "Guidance", phases: [], roles: ["worker"], enabled: true, content: null, defaultContent: "Default", defaultDigest: "a", editable: true }], mcp: [] }] };
  const calls: string[] = []; let fail = false;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(ConfigurationSettings, { bridge: { protocolVersion: 1, request: async input => {
    calls.push(input.method);
    if (input.method === "POST") {
      if (fail) return { status: 409, body: { error: "changed" } };
      const body = JSON.parse(input.body!); state = structuredClone(state); state.packages[0]!.revision++;
      state.packages[0]!.resources[0]!.content = body.resources[0].content;
      state.packages[0]!.userResources = body.userResources;
    }
    return { status: 200, body: state };
  } } })));
  const click = async (text: string) => act(async () => { [...node.querySelectorAll("button")].find(b => b.textContent === text)!.click(); });
  const field = () => node.querySelector("textarea")!;
  const edit = async (value: string) => act(async () => { field().value = value; Simulate.change(field()); });
  expect(calls).toEqual(["GET"]); await edit("Edited"); await click("保存配置");
  expect(state.packages[0]!.resources[0]!.content).toBe("Edited");
  await click("恢复默认内容"); expect(field().value).toBe("Edited"); await click("确认恢复");
  expect(field().value).toBe("Default"); await click("保存配置"); expect(state.packages[0]!.resources[0]!.content).toBeNull();
  fail = true; await edit("Keep draft"); await click("保存配置"); expect(field().value).toBe("Keep draft");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("changed");
  await click("重新读取"); expect(field().value).toBe("Keep draft"); await click("保留草稿"); expect(field().value).toBe("Keep draft");
  fail = false; await click("新建资源");
  const custom = node.querySelector<HTMLTextAreaElement>('[aria-label="用户资源正文"]')!;
  await act(async () => { custom.value = "Custom guidance"; Simulate.change(custom); });
  await click("删除此资源");
  const upload = node.querySelector<HTMLInputElement>('[aria-label="导入资源正文"]')!;
  expect(upload.accept).toBe(".md,.txt");
  Object.defineProperty(upload, "files", { configurable: true, value: [{ name: "guide.md", size: 8, arrayBuffer: async () => new TextEncoder().encode("Imported").buffer }] });
  await act(async () => { Simulate.change(upload); });
  expect(node.querySelector('[aria-label="删除资源确认"]')).toBeNull();
  expect(node.querySelector('[aria-label="替换正文确认"]')).not.toBeNull();
  expect([...node.querySelectorAll("button")].find(b => b.textContent === "重新读取")!.disabled).toBe(true);
  expect([...node.querySelectorAll("button")].find(b => b.textContent === "保存配置")!.disabled).toBe(true);
  await click("替换正文"); expect(custom.value).toBe("Imported");
  await click("保存配置"); expect(state.packages[0]!.userResources?.[0]?.content).toBe("Imported");
  expect(state.packages[0]!.userResources?.[0]?.source).toEqual({kind:"file",name:"guide.md"});
  expect(node.textContent).toContain("guide.md");
  await click("删除此资源"); await click("确认删除"); await click("保存配置");
  expect(state.packages[0]!.userResources).toEqual([]);
});
