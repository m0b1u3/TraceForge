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
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>本机网页交互验收</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f8f9fa;color:#252629;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px;padding:0 36px;border-bottom:1px solid #e9eaed;background:#fff}
header strong{font-size:14px}header span{color:#687078;font-size:11px}main{max-width:800px;margin:0 auto;padding:52px 36px 80px}
h1{margin:0 0 12px;font-size:32px;line-height:1.3;letter-spacing:-.035em}p{margin:0;line-height:1.75}.intro{max-width:52ch;color:#60656d}
.field{margin-top:38px;padding:26px 28px 28px;border:1px solid #e5e7eb;border-radius:14px;background:#fff}
label{display:block;margin-bottom:10px;font-size:13px;font-weight:600}input{display:block;width:100%;min-height:46px;padding:10px 14px;border:1px solid #cfd4db;border-radius:8px;background:#fff;color:#252629;font:inherit}
input:focus-visible,button:focus-visible{outline:2px solid #606a78;outline-offset:2px}.hint{margin:9px 0 22px;color:#687078;font-size:12px}
.value-label{font-size:11px;color:#687078}.value{min-height:26px;margin-top:2px;font-size:15px;font-weight:500;overflow-wrap:anywhere}
button{min-height:38px;margin-top:24px;padding:7px 14px;border:1px solid #d9dce1;border-radius:8px;background:#fff;color:inherit;cursor:pointer;font:inherit;font-size:12px}
button:hover{background:#f2f3f5}.isolation{margin-top:10px;color:#687078;font-size:12px}.scroll-check{margin-top:420px;padding-top:24px;border-top:1px solid #e2e5e9;color:#687078;font-size:12px}
@media(max-width:600px){header{padding-inline:20px}main{padding:36px 20px}.field{padding:20px}}
</style>
<header><strong>网页交互验收</strong><span>本机测试内容 · 非外部目标</span></header>
<main><h1>同一页面，持续操作</h1><p class="intro">在这里输入一段文字，再交回给智能体。它会读取这个原生网页的当前状态。</p>
<div class="field"><label for="page-input">页面输入</label><input id="page-input" aria-label="页面输入" oninput="document.querySelector('#result').textContent=this.value"><p class="hint">输入会立即反映在下方，交回后仍保留在同一页面。</p>
<div class="value-label">当前页面值</div><p class="value" id="result">等待输入</p><button onclick="document.querySelector('#isolation').textContent='宿主桥接：'+typeof require+' / '+typeof window.traceforgeDesktop">检查网页隔离</button><p class="isolation" id="isolation" role="status">隔离结果尚未检查</p></div>
<p class="scroll-check">滚动到此处可确认原生网页保持独立滚动。</p></main></html>`;
const broker = new BrokeredHttpGateway({ limits: { maximumRequestBytes: 1024*1024, maximumResponseBytes: 64*1024*1024,
  maximumHeaders: 128, maximumConcurrentRequests: 32, maximumTimeoutMs: 60_000 },
  authorizer: { authorize: input => grant(input.url) }, transport: async () => ({ status: 200,
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
