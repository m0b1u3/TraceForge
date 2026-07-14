import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page, type Response } from "playwright";
import { checkScope } from "@traceforge/tool-resolver";
import type { ScopeRule, TrafficEntry } from "@traceforge/shared";
import type { EventBus } from "./event-bus.js";
import type { TrafficStore } from "./stores/traffic-store.js";

type Controller = "llm" | "human";

/**
 * 人机共享浏览器会话（每 Case 一个）：持久有头 Chromium + 控制权锁 + 流量监听。
 * - 控制权锁：默认 LLM 持有，人接管/交回切换（纯状态，无 playwright 依赖，可单测）。
 * - 流量监听：page.on("response") 不管谁操作产生的流量都进 traffic store + emit。
 * 实现 extension 的 BrowserController 结构接口。
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private attachedPages = new WeakSet<Page>();
  private _controller: Controller = "llm";
  private stopped = true;

  // scopeRules 用 getter 实时取：对话中批准纳入的新 host 立即对正在运行的浏览器生效，
  // 不再是 start 时的快照（否则对话扩范围后已开的浏览器仍按旧空范围过滤掉一切流量）。
  private scopeRules: () => ScopeRule[];

  constructor(
    private caseId: string,
    scopeRules: ScopeRule[] | (() => ScopeRule[]),
    private traffic: TrafficStore,
    private bus: EventBus,
    private launchOptions: LaunchOptions = { headless: false },
    private onStopped?: () => void,
  ) {
    this.scopeRules = typeof scopeRules === "function" ? scopeRules : () => scopeRules;
  }

  async start(): Promise<void> {
    if (this.browser?.isConnected()) return;
    const browser = await chromium.launch(this.launchOptions);
    this.browser = browser;
    this.stopped = false;
    browser.on("disconnected", () => {
      if (this.browser === browser) this.finishStopped();
    });
    this.context = await this.browser.newContext();
    await this.context.addInitScript(() => {
      const state = { locked: false };
      const blocker = (event: Event) => {
        if (!state.locked) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      for (const type of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "keydown", "keyup", "beforeinput", "wheel"]) {
        globalThis.addEventListener(type, blocker, { capture: true, passive: false });
      }
      Object.defineProperty(globalThis, "__traceforgeSetInputLocked", {
        configurable: true,
        value: (locked: boolean) => {
          state.locked = locked;
          document.getElementById("traceforge-control-lock")?.remove();
          if (!locked || !document.documentElement) return;
          const overlay = document.createElement("div");
          overlay.id = "traceforge-control-lock";
          overlay.setAttribute("role", "status");
          Object.assign(overlay.style, {
            position: "fixed",
            inset: "0",
            zIndex: "2147483647",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "14px",
            background: "rgba(5, 10, 13, 0.08)",
            pointerEvents: "all",
            cursor: "not-allowed",
          });
          const notice = document.createElement("span");
          notice.textContent = "Controlled by TraceForge Agent · Take over from the workbench to interact";
          Object.assign(notice.style, {
            padding: "8px 12px",
            border: "1px solid rgba(121, 200, 170, 0.35)",
            borderRadius: "6px",
            background: "rgba(10, 18, 22, 0.92)",
            color: "#d9eee6",
            boxShadow: "0 8px 28px rgba(0, 0, 0, 0.22)",
            font: "500 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace",
          });
          overlay.appendChild(notice);
          document.documentElement.appendChild(overlay);
        },
      });
    });
    this.context.on("page", (page) => this.attachPage(page));
    this.page = await this.context.newPage();
    this.attachPage(this.page);
    await this.setHumanInputLocked(true);
    this.bus.emit({ type: "browser_started", caseId: this.caseId });
  }

  private attachPage(page: Page): void {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    this.page = page;
    void this.setPageInputLocked(page, this._controller === "llm");
    page.on("response", (res) => this.captureResponse(res));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.page = page;
        void this.setPageInputLocked(page, this._controller === "llm");
        this.bus.emit({ type: "browser_navigated", caseId: this.caseId, url: page.url() });
      }
    });
    page.on("close", () => {
      if (this.page !== page) return;
      this.page = this.context?.pages().find((candidate) => !candidate.isClosed()) ?? null;
    });
  }

  private captureResponse(res: Response): void {
    if (!/^https?:/i.test(res.url())) return;
    const req = res.request();
    const entry: TrafficEntry = {
      id: `traf_${randomUUID()}`,
      caseId: this.caseId,
      url: res.url(),
      method: req.method(),
      requestHeaders: req.headers(),
      requestBody: req.postData() ?? null,
      responseStatus: res.status(),
      responseBody: null,
      createdAt: new Date().toISOString(),
    };
    this.traffic.add(entry);
    this.bus.emit({ type: "response_captured", entry });
    void this.enrichBody(res, entry.id);
  }

  private async enrichBody(res: Response, entryId: string): Promise<void> {
    const body = await this.captureBody(res);
    if (body) this.traffic.updateBody(entryId, body);
  }

  private async captureBody(res: Response): Promise<string | null> {
    try {
      const headers = res.headers();
      const contentType = String(headers["content-type"] ?? "").toLowerCase();
      const contentLength = Number(headers["content-length"] ?? NaN);
      if (contentLength > 256_000) return null;
      if (!contentType || contentType.includes("image/") || contentType.includes("video/") || contentType.includes("audio/") || contentType.includes("application/octet-stream")) return null;
      const buffer = await res.body();
      if (!buffer) return null;
      const text = buffer.toString("utf-8");
      return text.length > 256_000 ? text.slice(0, 256_000) : text;
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    const browser = this.browser;
    if (browser?.isConnected()) await browser.close();
    this.finishStopped();
  }

  private finishStopped(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.bus.emit({ type: "browser_stopped", caseId: this.caseId });
    this.onStopped?.();
  }

  private async setPageInputLocked(page: Page, locked: boolean): Promise<void> {
    if (page.isClosed()) return;
    await page.evaluate((nextLocked) => {
      const setter = (globalThis as typeof globalThis & { __traceforgeSetInputLocked?: (value: boolean) => void }).__traceforgeSetInputLocked;
      setter?.(nextLocked);
    }, locked).catch(() => {});
  }

  private async setHumanInputLocked(locked: boolean): Promise<void> {
    await Promise.all((this.context?.pages() ?? []).map((page) => this.setPageInputLocked(page, locked)));
  }

  private async withAgentInput<T>(action: () => Promise<T>): Promise<T> {
    await this.setHumanInputLocked(false);
    try {
      return await action();
    } finally {
      await this.setHumanInputLocked(this._controller === "llm");
    }
  }

  // ---- 控制权锁（纯状态，无 playwright 依赖，可单测）----
  controller(): Controller {
    return this._controller;
  }
  controllerIs(c: Controller): boolean {
    return this._controller === c;
  }
  async acquireByHuman(): Promise<void> {
    this._controller = "human";
    await this.setHumanInputLocked(false);
    this.bus.emit({ type: "browser_control_changed", caseId: this.caseId, controller: "human" });
  }
  async releaseToLlm(): Promise<void> {
    this._controller = "llm";
    await this.setHumanInputLocked(true);
    this.bus.emit({ type: "browser_control_changed", caseId: this.caseId, controller: "llm" });
  }

  currentUrl(): string {
    return this.page?.url() ?? "";
  }

  // ---- 浏览器操作（BrowserController 接口）----
  async navigate(url: string): Promise<{ ok: boolean; content: string }> {
    const verdict = checkScope(url, this.scopeRules());
    if (!verdict.allowed) return { ok: false, content: `out of scope: ${verdict.reason}` };
    if (!this.page) return { ok: false, content: "浏览器未启动" };
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    this.bus.emit({ type: "browser_navigated", caseId: this.caseId, url });
    return { ok: true, content: `已导航到 ${url}（状态见 traffic）` };
  }
  async click(selector: string): Promise<{ ok: boolean; content: string }> {
    if (!this.page) return { ok: false, content: "浏览器未启动" };
    try {
      await this.withAgentInput(() => this.page!.click(selector, { timeout: 5000 }));
      return { ok: true, content: `已点击 ${selector}` };
    } catch (e) {
      return { ok: false, content: `点击失败：${(e as Error).message}` };
    }
  }
  async fill(selector: string, value: string): Promise<{ ok: boolean; content: string }> {
    if (!this.page) return { ok: false, content: "浏览器未启动" };
    try {
      await this.withAgentInput(() => this.page!.fill(selector, value, { timeout: 5000 }));
      return { ok: true, content: `已填入 ${selector}` };
    } catch (e) {
      return { ok: false, content: `填值失败：${(e as Error).message}` };
    }
  }
  async extractLinks(): Promise<string[]> {
    if (!this.page) return [];
    return this.page.$$eval("a[href]", (els) => els.map((e) => (e as HTMLAnchorElement).href));
  }
  async getPageText(): Promise<string> {
    if (!this.page) return "";
    return this.page.evaluate(() => document.body?.innerText ?? "");
  }
}
