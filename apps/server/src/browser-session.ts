import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page, type Response } from "playwright";
import { checkScope } from "@traceforge/tool-resolver";
import type { ScopeRule } from "@traceforge/shared";
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
  private _controller: Controller = "llm";

  // scopeRules 用 getter 实时取：对话中批准纳入的新 host 立即对正在运行的浏览器生效，
  // 不再是 start 时的快照（否则对话扩范围后已开的浏览器仍按旧空范围过滤掉一切流量）。
  private scopeRules: () => ScopeRule[];

  constructor(
    private caseId: string,
    scopeRules: ScopeRule[] | (() => ScopeRule[]),
    private traffic: TrafficStore,
    private bus: EventBus,
    private launchOptions: LaunchOptions = { headless: false },
  ) {
    this.scopeRules = typeof scopeRules === "function" ? scopeRules : () => scopeRules;
  }

  async start(): Promise<void> {
    if (this.browser) return; // 幂等
    this.browser = await chromium.launch(this.launchOptions);
    this.context = await this.browser.newContext();
    this.context.on("page", (page) => this.attachPage(page));
    this.page = await this.context.newPage();
    this.attachPage(this.page);
    this.bus.emit({ type: "browser_started", caseId: this.caseId });
  }

  private attachPage(page: Page): void {
    this.page = page;
    page.on("response", (res) => this.captureResponse(res));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.page = page;
        this.bus.emit({ type: "browser_navigated", caseId: this.caseId, url: page.url() });
      }
    });
    page.on("close", () => {
      if (this.page !== page) return;
      this.page = this.context?.pages().find((candidate) => !candidate.isClosed()) ?? null;
    });
  }

  private captureResponse(res: Response): void {
    const verdict = checkScope(res.url(), this.scopeRules());
    if (!verdict.allowed) return;
    this.traffic.add({
      id: `traf_${randomUUID()}`,
      caseId: this.caseId,
      url: res.url(),
      method: res.request().method(),
      requestHeaders: res.request().headers(),
      responseStatus: res.status(),
      responseBody: null,
      createdAt: new Date().toISOString(),
    });
    this.bus.emit({
      type: "response_captured",
      entry: this.traffic.listByCase(this.caseId).at(-1)!,
    });
  }

  async stop(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    this.bus.emit({ type: "browser_stopped", caseId: this.caseId });
  }

  // ---- 控制权锁（纯状态，无 playwright 依赖，可单测）----
  controller(): Controller {
    return this._controller;
  }
  controllerIs(c: Controller): boolean {
    return this._controller === c;
  }
  acquireByHuman(): void {
    this._controller = "human";
    this.bus.emit({ type: "browser_control_changed", caseId: this.caseId, controller: "human" });
  }
  releaseToLlm(): void {
    this._controller = "llm";
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
      await this.page.click(selector, { timeout: 5000 });
      return { ok: true, content: `已点击 ${selector}` };
    } catch (e) {
      return { ok: false, content: `点击失败：${(e as Error).message}` };
    }
  }
  async fill(selector: string, value: string): Promise<{ ok: boolean; content: string }> {
    if (!this.page) return { ok: false, content: "浏览器未启动" };
    try {
      await this.page.fill(selector, value, { timeout: 5000 });
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
