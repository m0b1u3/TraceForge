// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AuthorizationForm } from "./authorization-form";
const contract = { version: 1, description: "合成范围表单", fields: [
  { path: ["items"], label: "资源", description: "每行一个资源", type: "string-list", required: true, maximumItems: 4, maximumLength: 200 },
] };
let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); });
async function render(value: unknown = contract, disabled = false, policy: unknown = { allowedActions: ["resource.read"], deniedActions: [], resources: [] }) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const register = vi.fn(async () => true), node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(AuthorizationForm, { contract: value, policy, disabled, register })));
  const click = async (label: string) => act(async () => [...node.querySelectorAll("button")].find(item => item.textContent === label)!.click());
  const fill = async (value: string) => act(async () => {
    const field = node.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { node, register, click, fill };
}
it("requires explicit reviewed consent and sends only literal resources without dispatch", async () => {
  const f = await render(); await f.click("核对授权"); expect(f.node.textContent).toContain("请填写资源");
  await f.fill("first\n<script>second</script>"); await f.click("核对授权");
  expect(f.node.querySelector("script")).toBeNull(); expect(f.register).not.toHaveBeenCalled();
  await f.click("确认登记授权"); expect(f.register).not.toHaveBeenCalled();
  await act(async () => f.node.querySelector<HTMLInputElement>("input")!.click()); await f.click("确认登记授权");
  expect(f.register).toHaveBeenCalledWith({ items: ["first", "<script>second</script>"] }, expect.any(String));
  expect(f.node.querySelector("textarea")!.value).toBe("");
});
it("invalidates reviewed consent after edits and keeps content after rejection", async () => {
  const f = await render(); f.register.mockResolvedValue(false);
  await f.fill("first"); await f.click("核对授权"); await act(async () => f.node.querySelector<HTMLInputElement>("input")!.click());
  await f.click("返回修改"); await f.fill("second"); expect(f.node.querySelector("input")).toBeNull();
  await f.click("核对授权"); expect(f.node.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
  await act(async () => f.node.querySelector<HTMLInputElement>("input")!.click()); await f.click("确认登记授权");
  expect(f.node.textContent).toContain("second"); await f.click("返回修改"); expect(f.node.querySelector("textarea")!.value).toBe("second");
});
it("blocks unsupported contracts", async () => {
  const f = await render({ ...contract, version: 9 }); expect(f.node.textContent).toContain("不受支持");
  expect(f.node.querySelector("textarea")).toBeNull(); expect(f.register).not.toHaveBeenCalled();
});
it("disables the form while another command is pending", async () => {
  const f = await render(contract, true); expect(f.node.querySelector("fieldset")!.disabled).toBe(true);
  await f.click("核对授权"); expect(f.node.querySelector("input")).toBeNull(); expect(f.register).not.toHaveBeenCalled();
});
it("does not allow consent without the host's policy review", async () => {
  const f = await render(contract, false, null); expect(f.node.textContent).toContain("不受支持");
  expect(f.node.querySelector("textarea")).toBeNull();
});
it("shows fixed policy resources instead of hiding them behind the dynamic inputs", async () => {
  const f = await render(contract, false, { allowedActions: ["resource.read"], deniedActions: ["resource.change"],
    resources: [{ kind: "resource", values: ["fixed-first"] }, { kind: "resource", prefixValues: ["fixed-second/"] }] });
  await f.fill("first"); await f.click("核对授权");
  expect(f.node.textContent).toContain("精确匹配：fixed-first"); expect(f.node.textContent).toContain("前缀匹配：fixed-second/");
  expect(f.node.textContent).toContain("resource.change");
});
it("keeps optional fields in a disclosure, but never hides a required field", async () => {
  const f = await render({ ...contract, fields: [
    { ...contract.fields[0], advanced: true },
    { ...contract.fields[0], path: ["optional"], label: "可选资源", required: false, advanced: true },
  ] });
  expect(f.node.querySelector("fieldset > label")).not.toBeNull();
  const disclosure = f.node.querySelector<HTMLDetailsElement>(".authorization-options")!;
  expect(disclosure.open).toBe(false); expect(disclosure.querySelector("textarea")).not.toBeNull();
});
