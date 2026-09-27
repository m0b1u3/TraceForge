// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TaskDefinitionSchema, defaultTaskPreset, readTaskPreset, saveTaskPreset, taskScope, taskInputs,
  readDefaultTaskKind, saveDefaultTask } from "./task-preferences";
import { TaskPreferencesSettings } from "./task-preferences-settings";
import blackbox from "../../../scenarios/web-blackbox/scenario.json";

const definition = TaskDefinitionSchema.parse({ kind: "neutral", version: 1, title: "Neutral task",
  authorizationForm: { version: 1, description: "Resources", fields: [
    { path: ["targets"], label: "目标", description: "Literal target", type: "string-list", required: true },
    { path: ["network"], label: "联网范围", description: "Literal prefix", type: "string-list", required: false, advanced: true },
    { path: ["autonomy"], label: "连续执行", description: "Explicit opt in", type: "boolean", required: false },
  ] }, authorizationReview: { actionSelection: true, allowedActions: ["read", "write", "denied"], deniedActions: ["denied"], resources: [] } });
let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); localStorage.clear(); });
async function mount(element: React.ReactElement) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(element)); return node;
}

it("keeps legacy preference helpers readable while new tasks choose current defaults", () => {
  const preset = readTaskPreset(definition);
  expect(preset.actions).toEqual(["read", "write"]);
  expect(preset.inputs).toEqual(["", "", "false"]);
  const changed = { ...preset, inputs: ["", "https://docs.example/", "true"] };
  saveTaskPreset(definition, changed);
  expect(taskScope(definition, readTaskPreset(definition), ["target", ...changed.inputs.slice(1)])).toMatchObject({
    targets: ["target"], network: ["https://docs.example/"], autonomy: true,
  });
  expect(() => readTaskPreset({ ...definition, version: 2 })).toThrow("场景配置已变化");
});

it("allows a default Scenario selection without an operation or permission form", async () => {
  const second = { ...definition, kind: "second", title: "Second task" };
  const request = vi.fn(async () => ({ status: 200, body: [definition, second] }));
  await mount(<TaskPreferencesSettings bridge={{ protocolVersion: 1, request }} />);
  expect(document.body.textContent).toContain("输入目标即可启动");
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(document.querySelectorAll("textarea")).toHaveLength(0);
  await act(async () => { const select = document.querySelector("select")!; select.value = "second"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(readDefaultTaskKind([definition, second])).toBe("second");
  expect(request).toHaveBeenCalledTimes(1);
});

it("ignores stale or unreadable settings when selecting the only installed Scenario", async () => {
  localStorage.setItem("traceforge.desktop.task-preferences.v1", "{}");
  expect(readDefaultTaskKind([definition])).toBe("neutral");
  await mount(<TaskPreferencesSettings bridge={{ protocolVersion: 1, request: vi.fn(async () => ({ status: 200, body: [definition] })) }} />);
  expect(document.body.textContent).toContain("当前场景：Neutral task");
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  saveDefaultTask(definition);
  expect(readDefaultTaskKind([definition])).toBe("neutral");
});

it("starts the shipped Scenario with no target or network authorization form", () => {
  const current = TaskDefinitionSchema.parse({ ...blackbox.definition, authorizationForm: blackbox.authorizationPolicy.form,
    authorizationReview: { actionSelection: true, allowedActions: blackbox.authorizationPolicy.allowedActions,
      deniedActions: [], resources: blackbox.authorizationPolicy.resources } });
  const preset = defaultTaskPreset(current), scope = taskScope(current, preset);
  expect(scope).toMatchObject({ asynchronousWorkspace: true, interactiveWorkspace: true, workspaceWebSocket: true, continuousExecution: true });
  expect(scope).not.toHaveProperty("targets");
  expect(scope).not.toHaveProperty("workspaceNetworkPrefixes");
});

it("suggests literal URLs only when a Scenario declares that presentation hint", () => {
  const hinted = TaskDefinitionSchema.parse({ ...definition, authorizationForm: { ...definition.authorizationForm,
    fields: definition.authorizationForm.fields.map((field, index) => index === 0 ? { ...field, suggestion: "message-urls" } : field) } });
  const message = "查看 https://example.test/path?q=1";
  expect(taskInputs(definition, defaultTaskPreset(definition), message)[0]).toBe("");
  expect(taskInputs(hinted, defaultTaskPreset(hinted), message)[0]).toBe("https://example.test/path?q=1");
});
