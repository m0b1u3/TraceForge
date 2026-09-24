import { WebContentsView, session, type BrowserWindow } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { ChromiumCdpAdapter, type ChromiumCdpPort, type ChromiumCdpEvent,
  type BrowserArtifactPort, type BrowserProcessConfiguration, type BrokeredBrowserRuntimeOptions,
  type BrowserControllerConnection } from "@traceforge/browser-runtime";

type Owned = Awaited<ReturnType<NonNullable<BrokeredBrowserRuntimeOptions["chromiumProcess"]>>>;
type Bounds = { x: number; y: number; width: number; height: number };
interface Entry { view: WebContentsView; manual: boolean; closed: boolean; viewport: {width:number;height:number}; takeoverId?: string; window?: BrowserWindow; displayTimer?: ReturnType<typeof setTimeout>; destroy?: () => Promise<void>; }

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
    const entry: Entry = { view, manual: false, closed: false, viewport:{width:1024,height:720} }; this.entries.set(id, entry);
    const wc = view.webContents, listeners = new Set<(event: ChromiumCdpEvent) => void>(), failures = new Set<(error: Error) => void>();
    const root = `embedded:${wc.id}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let adapter: ChromiumCdpAdapter | undefined;
    let cleanup: Promise<void> | undefined;
    const destroy = (): Promise<void> => cleanup ??= (async () => {
      clearTimeout(timer); this.hide(id); entry.closed = true;
      if (!wc.isDestroyed()) {
        const destroyed = new Promise<void>(done => wc.once("destroyed", () => done()));
        wc.close({ waitForBeforeUnload: false });
        await Promise.race([destroyed, new Promise<never>((_, reject) => {
          const wait = setTimeout(() => reject(new Error("Embedded page destruction unconfirmed")), 5000); wait.unref();
        })]);
      }
      await isolated.closeAllConnections(); await isolated.clearStorageData(); this.entries.delete(id);
    })().catch(error => { cleanup = undefined; throw error; });
    entry.destroy = destroy;
    const fail = (error: Error) => { for (const listener of failures) listener(error); };
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-attach-webview", event => event.preventDefault());
    wc.on("will-frame-navigate", event => { if (!/^https?:\/\//i.test(event.url) && event.url !== "about:blank") event.preventDefault(); });
    wc.on("before-input-event", (event, input) => {
      if (!entry.manual) event.preventDefault();
      else if (input.type === "keyDown" && input.key === "F6") { event.preventDefault(); entry.window?.webContents.focus(); }
    });
    wc.on("before-mouse-event", event => { if (!entry.manual) event.preventDefault(); });
    wc.on("render-process-gone", () => fail(new Error("Embedded page renderer exited")));
    wc.debugger.on("detach", () => { if (!entry.closed) { this.hide(id); fail(new Error("Embedded page control detached")); } });
    wc.debugger.on("message", (_event, method, params, sessionId) => {
      for (const listener of listeners) listener({ method, params, sessionId: sessionId || root });
    });
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
            wc.debugger.sendCommand(method, params, sessionId === root ? undefined : sessionId)
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
      if(configuration.timeoutMs>0)timer = setTimeout(() => { this.hide(id); fail(new Error("Embedded browser deadline reached")); void destroy().catch(() => undefined); }, configuration.timeoutMs);
      const connection: BrowserControllerConnection = { proof: current.proof,
        start: (intercept, failure) => current.activate(intercept, failure),
        observe: request => current.observe(request), act: action => current.act(action),
        observeManual: (takeover, request) => current.observeManual(takeover, request),
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
    return ready.then(()=>{entry.viewport=viewport;return { url: safeAddress(entry.view.webContents.getURL()), title: entry.view.webContents.getTitle() };});
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
