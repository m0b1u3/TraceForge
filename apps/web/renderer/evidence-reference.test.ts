// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { EvidenceReference } from "./evidence-reference";

let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function mount(request: () => Promise<{ status: number; body: unknown }>) {
  vi.stubGlobal("crypto", webcrypto);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(EvidenceReference, { bridge: { protocolVersion: 1, request }, conversationId: "conversation", runId: "run", reference: "ref" })));
  return node;
}
it("reads only when opened and renders HTML as inert raw text", async () => {
  const body = Buffer.from('<img src="https://external.example" onerror="alert(1)">');
  const request = vi.fn(async () => ({ status: 200, body: { runId: "run", ref: "ref", artifactId: "artifact", summary: "Observation", kind: "browser.observation",
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}`, byteSize: body.length, format: "text", offset: 0, nextOffset: null, bodyBase64: body.toString("base64") } }));
  const node = await mount(request);
  expect(request).not.toHaveBeenCalled();
  await act(async () => { node.querySelector("button")!.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(node.querySelector("pre")?.textContent).toBe(body.toString());
  expect(node.querySelector("img")).toBeNull(); expect(node.querySelector("iframe")).toBeNull();
  expect(node.textContent).toContain("完整内容摘要已核对");
  await act(async () => node.querySelector("button")!.click());
  expect(node.querySelector("pre")).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
});
it("shows a recoverable unavailable reference without automatic retries", async () => {
  const request = vi.fn(async () => ({ status: 404, body: {} })); const node = await mount(request);
  await act(async () => node.querySelector("button")!.click());
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("没有可读取的本地正文");
  expect(request).toHaveBeenCalledTimes(1);
});
it("does not reopen or show an error from a read completed after closing", async () => {
  let finish!: (value: { status: number; body: unknown }) => void;
  const node = await mount(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => node.querySelector("button")!.click());
  expect(node.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => node.querySelector("button")!.click());
  await act(async () => finish({ status: 404, body: {} }));
  expect(node.querySelector(".evidence-reader")).toBeNull();
  expect(node.querySelector('[role="alert"]')).toBeNull();
});
