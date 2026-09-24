import { app, BrowserWindow, ipcMain } from "electron";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EmbeddedBrowser } from "../apps/desktop/src/embedded-browser.js";
import { BrokeredBrowserRuntime } from "../packages/browser-runtime/src/index.js";
import { BrokeredHttpGateway, type ExecutionNode } from "../packages/execution-node/src/index.js";
import assert from "node:assert/strict";

void app.whenReady().then(async () => {
const manager = new EmbeddedBrowser(), artifacts = new Map<string, Buffer>();
const save = (input: { bodyBase64: string }) => { const ref = `fixture:${artifacts.size}`; artifacts.set(ref, Buffer.from(input.bodyBase64, "base64")); return { ref }; };
const deployment = manager.deployment({ recordObservation: save, recordDownload: save });
const permissions = { version: 1 as const, platform: "darwin" as const, network: "brokered" as const, secrets: "deny" as const,
  process: { access: "sandboxed" as const, interactive: false, background: false }, filesystem: { read: [], write: [], deny: [] }, sources: ["fixture"] };
const owner = { caseId: "fixture", runId: "fixture", workId: "fixture", workerId: "fixture", scopeRef: "fixture", leaseId: "fixture",
  leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), authorizationAction: "browser.request" };
const grant = (url: string) => { if (!url.startsWith("https://embedded.fixture.invalid/")) throw new Error("Fixture scope denied");
  return { authorizationRef: "fixture", canonicalUrl: url, expiresAt: owner.leaseExpiresAt }; };
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>本地浏览器验收页</title><style>body{font:16px -apple-system,sans-serif;padding:36px;color:#202329}input{padding:12px;font:inherit;width:80%;border:1px solid #bbb;border-radius:8px}button{padding:12px;margin-top:20px;font:inherit}p{line-height:1.7}</style><h1>原生网页</h1><p>这是本地验收内容，不是外部测试目标。可以直接输入、选择文字和滚动。</p><label>页面输入<input aria-label="页面输入" oninput="document.querySelector('#result').textContent=this.value"></label><p id="result">等待输入</p><button onclick="document.querySelector('#result').textContent=typeof require+' / '+typeof window.traceforgeDesktop">检查网页隔离</button><div style="height:900px"></div><p>页面底部</p></html>`;
const broker = new BrokeredHttpGateway({ authorizer: { authorize: input => grant(input.url) }, transport: async () => ({ status: 200,
  headers: [{ name: "content-type", value: "text/html; charset=utf-8" }], body: Buffer.from(html) }) });
const runtime = new BrokeredBrowserRuntime({ executionNode: { requestHttp: request => broker.execute("fixture", request) } as ExecutionNode,
  controller: { attach: async () => { throw new Error("No external controller"); } }, chromiumProcess: deployment.chromiumProcess,
  authorization: { assertSessionCurrent() {}, authorizeRequest: async input => grant(input.url) }, artifacts: { recordObservation: save, recordDownload: save } });
let id: string | undefined;
const window = new BrowserWindow({ title: "TraceForge · 原生浏览器验收", width: 1440, height: 920,
  webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true,
    ...(process.env.TRACEFORGE_EMBEDDED_VISUAL === "1" ? { preload: resolve("output/embedded-browser-review-preload.cjs") } : {}) } });
try {
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<html lang="zh"><meta charset="utf-8"><style>body{margin:0;color:#202329;font:15px -apple-system,sans-serif}header{padding:18px 24px;border-bottom:1px solid #ddd}main{padding:48px;width:38%}p{line-height:1.8}.side{position:absolute;top:70px;left:47%;right:20px}h2{font-size:18px}</style><header>TraceForge · 原生窗口验收（合成任务数据）</header><main><h2>调查对话</h2><p>右侧是实际 WebContentsView，不是截图，也不是 iframe。</p><p>验证：输入、文字选择、滚动、交回和页面隔离。</p><p>此验收窗口不使用你的真实任务或模型凭证。</p></main><div class="side">浏览器 · 人工接管　　https://embedded.fixture.invalid/</div></html>')}`);
  const configuration = await deployment.prepare({ effectivePermissions: permissions }, new AbortController().signal);
  await assert.rejects(deployment.chromiumProcess(structuredClone(configuration), "forged"), /not prepared/);
  console.log("stage: open embedded runtime");
  const opened = await runtime.open(owner, configuration); id = opened.id;
  console.log("stage: observe blank page");
  const initial = await runtime.observe(id, { kind: "dom" });
  await runtime.act(id, { id: "navigate", kind: "navigate", view: initial.view, url: "https://embedded.fixture.invalid/" });
  console.log("stage: observe authorized page");
  const waitDom = async (text: string) => {
    for (let n = 0; n < 50; n++) { const result = await runtime.observe(id!, { kind: "dom" });
      const dom = JSON.parse(artifacts.get(result.artifactRef)!.toString());
      if (JSON.stringify(dom).includes(text)) return dom;
      await new Promise(done => setTimeout(done, 100));
    } throw new Error(`Missing DOM ${text}`);
  };
  const dom = await waitDom("页面输入");
  const hiddenScreenshot=await runtime.observe(id,{kind:"screenshot"});
  assert(artifacts.get(hiddenScreenshot.artifactRef)!.length>8,"unattached native view produces a real PNG");
  const input = dom.nodes.find((node: any) => node.name === "页面输入" && node.element);
  assert(input);
  await runtime.act(id, { id: "fill", kind: "fill", element: input.element, text: "同一页面状态" });
  assert.throws(() => manager.show(window, id!, "not-granted", { x: 672, y: 110, width: 740, height: 720 }), /unavailable/);
  await manager.show(window,id,null,{x:672,y:110,width:740,height:720});
  assert.equal(window.contentView.children.length,1,"active agent page is visible without takeover");
  const activeContents=(window.contentView.children[0] as import("electron").WebContentsView).webContents;
  let prevented=false;
  activeContents.emit("before-input-event",{preventDefault(){prevented=true;}},{type:"keyDown",key:"a"});
  assert(prevented,"live agent view blocks user keyboard input before takeover");
  const takeover = await runtime.beginManualControl(id);
  assert.throws(()=>manager.show(window,id!,null,{x:672,y:110,width:740,height:720}),/unavailable/);
  assert.throws(() => manager.show(window, id!, "stale", { x: 672, y: 110, width: 740, height: 720 }), /unavailable/);
  assert.throws(() => manager.show(window, id!, takeover.takeoverId, { x: 0, y: 0, width: 1440, height: 920 }), /bounds/);
  await manager.show(window, id, takeover.takeoverId, { x: 672, y: 110, width: 740, height: 720 });
  assert.equal(window.contentView.children.length, 1);
  const guest = window.contentView.children[0] as import("electron").WebContentsView;
  const guestContents = guest.webContents;
  assert.equal(guest.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(guest.webContents.getLastWebPreferences().nodeIntegration, false);
  assert.equal(guest.webContents.getLastWebPreferences().preload, undefined);
  await new Promise(done => setTimeout(done, 500));
  // capturePage contains the application renderer only, not native child views.
  // Actual composed visual acceptance uses the CUA window screenshot.
  await mkdir(resolve("output"), { recursive: true });
  await writeFile(resolve("output/native-browser-host-only.png"), (await window.capturePage()).toPNG());
  if (process.env.TRACEFORGE_EMBEDDED_VISUAL === "1") {
    ipcMain.handle("fixture:initialize", () => ({ sessionId: id, takeoverId: takeover.takeoverId }));
    ipcMain.handle("fixture:present", (_event, input) => input.hide ? (manager.hide(), { hidden: true })
      : manager.show(window, id!, takeover.takeoverId, input.bounds, input.focus === true));
    ipcMain.handle("fixture:command", async (_event, input) => {
      assert.equal(input.operation, "resume"); assert.equal(input.sessionId, id);
      await runtime.resumeManualControl(id!, input.takeoverId);
      const result = await runtime.observe(id!, { kind: "dom" });
      const text = artifacts.get(result.artifactRef)!.toString();
      console.log(JSON.stringify({ handback: true, nativeInputVisibleToAgent: text.includes("原生输入验证"), bridgeAbsent: text.includes("undefined / undefined") }));
      return true;
    });
    await window.loadFile(resolve("scripts/fixtures/embedded-browser-review.html"));
    console.log("READY: native fixture window is available for manual interaction");
    await new Promise<void>(done => window.once("closed", () => done()));
  } else {
    await new Promise(done => setTimeout(done, 2100));
    assert.equal(window.contentView.children.length, 0, "missing renderer heartbeat hides native view");
    await manager.show(window, id, takeover.takeoverId, { x: 672, y: 110, width: 740, height: 720 });
    await runtime.resumeManualControl(id, takeover.takeoverId);
    assert.equal(window.contentView.children.length, 0);
    assert.throws(() => manager.show(window, id!, takeover.takeoverId, { x: 672, y: 110, width: 740, height: 720 }), /unavailable/);
    await manager.show(window,id,null,{x:672,y:110,width:740,height:720});
    assert.equal(window.contentView.children.length,1,"same live page remains displayable after handback");
    await waitDom("同一页面状态");
    await runtime.observe(id,{kind:"screenshot"});
    await runtime.close(id); assert.equal(guestContents.isDestroyed(), true);
    console.log(JSON.stringify({ passed: true, nativeChildView: true, sandboxEnabled: true, sameSessionHandback: true, hiddenViewScreenshot:true, handbackScreenshot:true,
      cleanupConfirmed: true, takeoverAndBoundsGuards: true, heartbeatExpiry: true,
      hostOnlyScreenshotSha256: createHash("sha256").update((await window.capturePage()).toPNG()).digest("hex") }));
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (id) await runtime.close(id); await manager.shutdown(); if (!window.isDestroyed()) window.destroy(); app.exit(process.exitCode ?? 0); }
}).catch(error => { console.error(error); app.exit(1); });
