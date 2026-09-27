import { WebContentsView, session, type BrowserWindow } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { ChromiumCdpAdapter, type ChromiumCdpPort, type ChromiumCdpEvent,
  type BrowserArtifactPort, type BrowserProcessConfiguration, type BrokeredBrowserRuntimeOptions,
  type BrowserControllerConnection } from "@traceforge/browser-runtime";

type Owned = Awaited<ReturnType<NonNullable<BrokeredBrowserRuntimeOptions["chromiumProcess"]>>>;
type Bounds = { x: number; y: number; width: number; height: number };
interface Entry { pages: Map<string, WebContentsView>; activePage: string; createPage?: () => Promise<string>; closePage?: (pageId: string) => Promise<void>; view: WebContentsView; manual: boolean; closed: boolean; viewport: {width:number;height:number}; takeoverId?: string; window?: BrowserWindow; displayTimer?: ReturnType<typeof setTimeout>; destroy?: () => Promise<void>; }

/** Native views belong to the same session as the agent, never a second browser.
 * No preload, Node, application session, external opener or renderer CDP bridge. */
export class EmbeddedBrowser {
  private entries = new Map<string, Entry>();
  private prepared = new WeakSet<BrowserProcessConfiguration>();
  private visible?: string;
  deployment(artifacts: BrowserArtifactPort) {
    return { artifacts,
      prepare: async (context: { effectivePermissions: BrowserProcessConfiguration["permissions"] }, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (context.effectivePermissions.network !== "brokered" || context.effectivePermissions.process.access !== "sandboxed")
          throw new Error("Embedded browser requires authorized browser execution");
        const hash = createHash("sha256").update(`electron:${process.versions.electron}:${process.versions.chrome}`).digest("hex");
        // Build identity, not an OS sandbox measurement or source audit.
        const configuration: BrowserProcessConfiguration = { isolation: "chromium", controlTransport: "electron_debugger",
          controllerIdentity: { protocol: "traceforge.browser-controller.v1", controllerVersion: `electron/${process.versions.electron}`,
            controllerSha256: hash, browserVersion: `Chrome/${process.versions.chrome}`, browserSha256: hash },
          executable: process.execPath, arguments: [], workingDirectory: process.cwd(),
          permissions: structuredClone(context.effectivePermissions), timeoutMs: 0, outputLimitBytes: 1048576,
          resources: { cpuTimeMs: 900000, memoryBytes: 2147483648, maximumProcesses: 64, writeBytes: 268435456 } };
        this.prepared.add(configuration); return configuration;
      },
      chromiumProcess: (configuration: BrowserProcessConfiguration, id: string) => this.launch(configuration, id),
    };
  }

  private async launch(configuration: BrowserProcessConfiguration, id: string): Promise<Owned> {
    if (!this.prepared.delete(configuration) || configuration.isolation !== "chromium" || this.entries.has(id))
      throw new Error("Embedded browser launch was not prepared");
    const isolated = session.fromPartition(`traceforge-browser-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", event => event.preventDefault());
    // Defense in depth against un-intercepted HTTP sockets; page responses are
    // fulfilled through CDP. Not represented as a kernel denied-network policy.
    await isolated.setProxy({ mode: "fixed_servers", proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9", proxyBypassRules: "<-loopback>" });
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const scheme = new URL(details.url).protocol;
      callback({ cancel: !["http:", "https:", "about:", "data:", "blob:"].includes(scheme) });
    });
    const view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false,
      navigateOnDragDrop: false, safeDialogs: true, disableDialogs: true } });
    view.setBounds({ x: 0, y: 0, width: 1024, height: 720 }); view.setVisible(false);
    const entry: Entry = { pages: new Map(), activePage: `embedded:${view.webContents.id}`, view, manual: false, closed: false, viewport:{width:1024,height:720} }; this.entries.set(id, entry);
    const wc = view.webContents, listeners = new Set<(event: ChromiumCdpEvent) => void>(), failures = new Set<(error: Error) => void>();
    const root = `embedded:${wc.id}`;
    entry.pages.set(root, view);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let adapter: ChromiumCdpAdapter | undefined;
    let cleanup: Promise<void> | undefined;
    const destroy = (): Promise<void> => cleanup ??= (async () => {
      clearTimeout(timer); this.hide(id); entry.closed = true;
      for (const page of entry.pages.values()) {
        const contents = page.webContents;
        if (contents.isDestroyed()) continue;
        const destroyed = new Promise<void>(done => contents.once("destroyed", () => done()));
        contents.close({ waitForBeforeUnload: false });
        await Promise.race([destroyed, new Promise<never>((_, reject) => {
          const wait = setTimeout(() => reject(new Error("Embedded page destruction unconfirmed")), 5000); wait.unref();
        })]);
      }
      await isolated.closeAllConnections(); await isolated.clearStorageData(); this.entries.delete(id);
    })().catch(error => { cleanup = undefined; throw error; });
    entry.destroy = destroy;
    const fail = (error: Error) => { for (const listener of failures) listener(error); };
    const configurePage = (page: WebContentsView, pageId: string) => {
      const contents = page.webContents;
      contents.setWindowOpenHandler(({ url }) => {
        // Create only inside this session, after attaching interception.
        if (/^https?:\/\//i.test(url)) void (async () => {
          const id = await entry.createPage?.();
          if (id && !entry.closed) await entry.pages.get(id)!.webContents.loadURL(url).catch(() => undefined);
        })().catch(error => fail(error));
        return { action: "deny" };
      });
      contents.on("will-attach-webview", event => event.preventDefault());
      contents.on("will-frame-navigate", event => { if (!/^https?:\/\//i.test(event.url) && event.url !== "about:blank") event.preventDefault(); });
      contents.on("before-input-event", (event, input) => {
        if (!entry.manual) event.preventDefault();
        else if (input.type === "keyDown" && input.key === "F6") { event.preventDefault(); entry.window?.webContents.focus(); }
      });
      contents.on("before-mouse-event", event => { if (!entry.manual) event.preventDefault(); });
      contents.on("render-process-gone", () => fail(new Error("Embedded page renderer exited")));
      contents.debugger.on("detach", () => {
        if (!entry.closed && entry.pages.has(pageId)) { this.hide(id); fail(new Error("Embedded page control detached")); }
      });
      contents.debugger.on("message", (_event, method, params, sessionId) => {
        const mapped = { ...params };
        if (typeof mapped.sessionId === "string") mapped.sessionId = `${pageId}/${mapped.sessionId}`;
        for (const listener of listeners) listener({ method, params: mapped, sessionId: sessionId ? `${pageId}/${sessionId}` : pageId });
      });
    };
    configurePage(view, root);
    try {
      await wc.loadURL("about:blank"); wc.debugger.attach("1.3");
      // An unattached WebContentsView has a zero-sized renderer viewport even
      // after setBounds. Keep a real layout viewport for background observation.
      await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {...entry.viewport,deviceScaleFactor:1,mobile:false});
      const cdp: ChromiumCdpPort = {
        send: (method, params = {}, sessionId) => {
          if (entry.closed) return Promise.reject(new Error("Embedded page closed"));
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Embedded CDP timed out: ${method}`)), 10000);
            const [pageId, childId] = (sessionId ?? entry.activePage).split("/");
            const target = entry.pages.get(pageId!);
            if (!target || target.webContents.isDestroyed()) { clearTimeout(timeout); reject(new Error("Embedded page unavailable")); return; }
            const mapped = { ...params };
            if (typeof mapped.sessionId === "string") mapped.sessionId = mapped.sessionId.split("/").slice(1).join("/");
            target.webContents.debugger.sendCommand(method, mapped, childId)
              .then(resolve, reject).finally(() => clearTimeout(timeout));
          });
        },
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        onFailure(listener) { failures.add(listener); return () => failures.delete(listener); },
        close: destroy,
      };
      adapter = new ChromiumCdpAdapter({ cdp, identity: configuration.controllerIdentity, isolation: "chromium",
        embeddedTarget: { sessionId: root, targetId: root } });
      await adapter.initialize();
      const current = adapter;
      entry.createPage = async () => {
        if (entry.closed) throw new Error("Embedded session closed");
        const page = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, contextIsolation: true,
          nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
          webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false,
          navigateOnDragDrop: false, safeDialogs: true, disableDialogs: true } });
        const pageId = `embedded:${page.webContents.id}`;
        page.setBounds({ x: 0, y: 0, width: 1024, height: 720 }); page.setVisible(false);
        entry.pages.set(pageId, page); configurePage(page, pageId);
        try {
          await page.webContents.loadURL("about:blank");
          if (entry.closed) throw new Error("Embedded session closed");
          page.webContents.debugger.attach("1.3");
          await page.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {width:1024,height:720,deviceScaleFactor:1,mobile:false});
          await current.attachEmbeddedPage(pageId);
          this.selectPage(id, pageId);
          return pageId;
        } catch (error) {
          entry.pages.delete(pageId); current.detachEmbeddedPage(pageId);
          if (!page.webContents.isDestroyed()) page.webContents.close({waitForBeforeUnload:false});
          throw error;
        }
      };
      entry.closePage = async pageId => {
        const page = entry.pages.get(pageId);
        if (!page) throw new Error("Unknown browser tab");
        if (entry.pages.size === 1) await entry.createPage!();
        if (entry.activePage === pageId) this.selectPage(id, [...entry.pages.keys()].find(key => key !== pageId)!);
        entry.pages.delete(pageId); current.detachEmbeddedPage(pageId);
        if (!page.webContents.isDestroyed()) page.webContents.close({waitForBeforeUnload:false});
      };
      if(configuration.timeoutMs>0)timer = setTimeout(() => { this.hide(id); fail(new Error("Embedded browser deadline reached")); void destroy().catch(() => undefined); }, configuration.timeoutMs);
      const connection: BrowserControllerConnection = { proof: current.proof,
        start: (intercept, failure) => current.activate(intercept, failure),
        observe: request => current.observe({ ...request, pageId: request.pageId ?? entry.activePage }),
        act: action => { this.selectPage(id, "view" in action ? action.view.pageId : action.element.view.pageId); return current.act(action); },
        observeManual: (takeover, request) => current.observeManual(takeover, {...request,pageId:request.pageId??entry.activePage}),
        actManual: (takeover, action) => current.actManual(takeover, action),
        beginTakeover: async () => { const result = await current.beginTakeover(); if (entry.closed) throw new Error("Embedded page closed during takeover"); entry.manual = true; entry.takeoverId = result.takeoverId; return result; },
        resumeTakeover: async takeover => { entry.manual = false; this.hide(id); const result = await current.resumeTakeover(takeover); entry.takeoverId = undefined; return result; },
        close: async () => { entry.manual = false; this.hide(id); await current.close(); },
      };
      return { processId: root, connection, terminate: destroy };
    } catch (error) { await destroy(); throw error; }
  }

  show(window: BrowserWindow, id: string, takeoverId: string | null, bounds: Bounds, focus = false) {
    const entry = this.entries.get(id);
    if (!entry || entry.closed || window.isDestroyed() || (takeoverId===null ? entry.manual : !entry.manual || entry.takeoverId!==takeoverId)) throw new Error("Browser takeover unavailable");
    const [width, height] = window.getContentSize();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(value => typeof value === "number" && Number.isFinite(value))
      || bounds.x < 0 || bounds.y < 54 || bounds.width < 100 || bounds.height < 100
      || bounds.x + bounds.width > width + 1 || bounds.y + bounds.height > height + 1) throw new Error("Invalid embedded page bounds");
    if (this.visible && this.visible !== id) this.hide(this.visible);
    if (entry.window !== window) { entry.window?.contentView.removeChildView(entry.view); window.contentView.addChildView(entry.view); entry.window = window; }
    entry.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.floor(bounds.width), height: Math.floor(bounds.height) });
    entry.view.setVisible(true); this.visible = id;
    if (focus && entry.manual) entry.view.webContents.focus();
    clearTimeout(entry.displayTimer); entry.displayTimer = setTimeout(() => this.hide(id), 2000);
    const viewport={width:Math.floor(bounds.width),height:Math.floor(bounds.height)};
    const resized=viewport.width!==entry.viewport.width||viewport.height!==entry.viewport.height;
    const ready=resized?entry.view.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride",{...viewport,deviceScaleFactor:1,mobile:false}):Promise.resolve();
    return ready.then(()=>{entry.viewport=viewport;return { activePageId: entry.activePage, tabs: [...entry.pages].map(([id, page]) => ({ id, title: page.webContents.getTitle() || "新标签页", url: safeAddress(page.webContents.getURL()) })), url: safeAddress(entry.view.webContents.getURL()), title: entry.view.webContents.getTitle(), canGoBack: entry.view.webContents.navigationHistory.canGoBack(), canGoForward: entry.view.webContents.navigationHistory.canGoForward(), loading: entry.view.webContents.isLoading() };});
  }
  async navigate(id: string, takeoverId: string | null, input: unknown) {
    const entry = this.entries.get(id);
    if (!entry || entry.closed || !entry.manual || !takeoverId || entry.takeoverId !== takeoverId)
      throw new Error("Browser takeover unavailable");
    if (!input || typeof input !== "object") throw new Error("Invalid navigation");
    const { action, url, pageId } = input as { action?: unknown; url?: unknown; pageId?: unknown };
    if (action === "new-tab") { await entry.createPage!(); return; }
    if (action === "select-tab" || action === "close-tab") {
      if (typeof pageId !== "string" || !entry.pages.has(pageId)) throw new Error("Unknown browser tab");
      if (action === "select-tab") this.selectPage(id, pageId); else await entry.closePage!(pageId);
      return;
    }
    const wc = entry.view.webContents;
    if (action === "navigate") {
      if (typeof url !== "string" || url.length > 8192) throw new Error("Invalid address");
      const target = new URL(url);
      if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid address");
      await wc.loadURL(target.href);
    } else if (action === "back") {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    } else if (action === "forward") {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    } else if (action === "reload") wc.reload();
    else throw new Error("Invalid navigation action");
  }

  private selectPage(id: string, pageId: string) {
    const entry = this.entries.get(id), page = entry?.pages.get(pageId);
    if (!entry || !page) throw new Error("Unknown browser tab");
    if (entry.activePage === pageId) return;
    this.hide(id);
    entry.activePage = pageId; entry.view = page;
    // Each page has its own metrics; force the next presentation to resize.
    entry.viewport = {width:0,height:0};
  }

  hide(id?: string) {
    const key = id ?? this.visible; if (!key) return;
    const entry = this.entries.get(key);
    const focused = entry && !entry.view.webContents.isDestroyed() && entry.view.webContents.isFocused();
    entry?.view.setVisible(false);
    clearTimeout(entry?.displayTimer);
    if (entry?.window && !entry.window.isDestroyed()) {
      entry.window.contentView.removeChildView(entry.view);
      if (focused) entry.window.webContents.focus();
    }
    if (entry) entry.window = undefined;
    if (this.visible === key) this.visible = undefined;
  }
  async shutdown() { this.hide(); await Promise.all([...this.entries.values()].map(entry => entry.destroy?.())); }
}
function safeAddress(value: string) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : "about:blank"; }
  catch { return ""; }
}
