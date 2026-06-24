# Plan F1：人机共享浏览器后端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本计划在当前会话由控制者直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现人机共享浏览器的后端：持久有头 Chromium 会话（每 Case 一个）+ 控制权锁（LLM 默认持有，人接管）+ 浏览器工具（navigate/click/fill/extract_links/get_page_text，纳入 agent 工具集）+ 控制路由（start/stop/takeover/release），删除旧的一次性无头 `/open`。对应设计 docs/superpowers/specs/2026-06-24-shared-browser-design.md 的 Plan F1。

**Architecture:** server 新增 `BrowserSession`（持有有头 Playwright browser+page+控制权锁，挂 page.on("response") 流量监听）+ `Map<caseId, BrowserSession>` 管理。`@traceforge/extension` 新增 `browser-tools.ts`：浏览器工具工厂（注入实现 `BrowserController` 结构接口的 session）。routes.ts 加 browser/start|stop|takeover|release 路由、删旧 /open、agent 路由按 case 注册浏览器工具。`@traceforge/shared` 加浏览器事件。

**Tech Stack:** 沿用前序（TypeScript、pnpm、Vitest、Fastify、Playwright、AgentRuntime/ToolRegistry）。

## Global Constraints

- 沿用全部既有约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest、`@traceforge/shared` 单源类型、所有业务表带 case_id、纯逻辑模块必须单测。
- **零硬编码（设计文档 3.0）**：浏览器工具领域无关（导航/点击/提取，不含漏洞逻辑）。
- **控制权锁**：BrowserSession 默认 controller="llm"；浏览器工具 execute 前必须 `controllerIs("llm")`，否则返回 `{ok:false, content:"人正在操作浏览器，请等待交回"}`；锁只挡浏览器工具，不挡其它工具。
- **Scope Guard**：navigate 目标 host 必过 `checkScope`，越界返回 `{ok:false}`，不发出导航。
- **流量自动进库**：page.on("response") 不管谁操作产生的流量都进 traffic store + emit `response_captured`。
- **真实有头浏览器不单测**（要起真窗口）；可单测部分：控制权锁状态机（纯逻辑）、浏览器工具的锁/scope 逻辑（注入 mock controller）、控制路由状态变更（inject）。真实 navigate/click 靠端到端手动验证。
- **extension 不依赖 server**：浏览器工具用结构接口 `BrowserController` 注入，不直接依赖 BrowserSession 类。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: shared —— 浏览器事件类型

**Files:**
- Modify: `packages/shared/src/events.ts`
- Test: `packages/shared/src/phase-f1-events.test.ts`

**Interfaces:**
- Consumes: 现有 `RuntimeEvent`。
- Produces：`RuntimeEvent` 新增 `browser_started`/`browser_stopped`/`browser_control_changed`/`browser_navigated`。

- [ ] **Step 1: 写失败测试 `packages/shared/src/phase-f1-events.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "./events.js";

describe("browser events", () => {
  it("accepts browser lifecycle and control events", () => {
    const events: RuntimeEvent[] = [
      { type: "browser_started", caseId: "c" },
      { type: "browser_stopped", caseId: "c" },
      { type: "browser_control_changed", caseId: "c", controller: "human" },
      { type: "browser_navigated", caseId: "c", url: "https://t.com/" },
    ];
    expect(events).toHaveLength(4);
    expect(events[2].type).toBe("browser_control_changed");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/shared/src/phase-f1-events.test.ts`
Expected: FAIL —— 类型不存在，编译错。

- [ ] **Step 3: 扩展 `packages/shared/src/events.ts`**

在 `RuntimeEvent` 联合末尾追加：

```ts
  | { type: "browser_started"; caseId: string }
  | { type: "browser_stopped"; caseId: string }
  | { type: "browser_control_changed"; caseId: string; controller: "llm" | "human" }
  | { type: "browser_navigated"; caseId: string; url: string }
```

- [ ] **Step 4: 运行确认通过 + 全 shared 测试 + tsc**

Run: `pnpm vitest run packages/shared && pnpm --filter @traceforge/shared exec tsc --noEmit -p tsconfig.json`
Expected: 全绿；tsc 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(shared): add browser session event types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: extension —— 浏览器工具（受控制权锁 + Scope Guard）

**Files:**
- Create: `packages/extension/src/browser-tools.ts`
- Modify: `packages/extension/src/index.ts`
- Test: `packages/extension/src/browser-tools.test.ts`

**Interfaces:**
- Consumes: `ToolDescriptor`、`checkScope`（`@traceforge/tool-resolver`）、`ScopeRule`（`@traceforge/shared`）。
- Produces：
  - `interface BrowserController { controllerIs(c: "llm" | "human"): boolean; navigate(url: string): Promise<{ ok: boolean; content: string }>; click(selector: string): Promise<{ ok: boolean; content: string }>; fill(selector: string, value: string): Promise<{ ok: boolean; content: string }>; extractLinks(): Promise<string[]>; getPageText(): Promise<string> }`
  - `makeBrowserTools(session: BrowserController, scopeRules: ScopeRule[]): ToolDescriptor[]` —— 返回 navigate/click/fill/extract_links/get_page_text 五个工具，全 normal 风险，execute 内先 `session.controllerIs("llm")` 否则返回"请等待交回"；navigate 额外 `checkScope`。

- [ ] **Step 1: 写失败测试 `packages/extension/src/browser-tools.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { makeBrowserTools, type BrowserController } from "./browser-tools.js";
import type { ScopeRule } from "@traceforge/shared";

const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }];

function mockController(opts: { controller?: "llm" | "human" } = {}): BrowserController {
  const log: string[] = [];
  return {
    controllerIs: (c) => (opts.controller ?? "llm") === c,
    navigate: async (url) => { log.push(`nav:${url}`); return { ok: true, content: `navigated ${url}` }; },
    click: async (sel) => { log.push(`click:${sel}`); return { ok: true, content: `clicked ${sel}` }; },
    fill: async (sel, v) => { log.push(`fill:${sel}=${v}`); return { ok: true, content: `filled` }; },
    extractLinks: async () => ["https://t.com/a", "https://t.com/b"],
    getPageText: async () => "page body text",
    // 暴露 log 供断言
    _log: log,
  } as BrowserController & { _log: string[] };
}

function tool(tools: ReturnType<typeof makeBrowserTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe("makeBrowserTools (LLM holds control)", () => {
  it("navigate executes for an in-scope url", async () => {
    const tools = makeBrowserTools(mockController(), rules);
    const res = await tool(tools, "navigate").execute({ url: "https://t.com/x" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("navigated");
  });

  it("navigate refuses an out-of-scope url (scope guard)", async () => {
    const tools = makeBrowserTools(mockController(), rules);
    const res = await tool(tools, "navigate").execute({ url: "https://evil.com/x" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/scope/i);
  });

  it("click/fill/extract_links/get_page_text execute", async () => {
    const tools = makeBrowserTools(mockController(), rules);
    expect((await tool(tools, "click").execute({ selector: "#a" })).ok).toBe(true);
    expect((await tool(tools, "fill").execute({ selector: "#u", value: "admin" })).ok).toBe(true);
    expect((await tool(tools, "extract_links").execute({})).content).toContain("t.com/a");
    expect((await tool(tools, "get_page_text").execute({})).content).toContain("page body");
  });

  it("all browser tools are normal risk", () => {
    const tools = makeBrowserTools(mockController(), rules);
    expect(tools.every((t) => t.risk === "normal")).toBe(true);
    expect(tools.map((t) => t.name).sort()).toEqual(["click", "extract_links", "fill", "get_page_text", "navigate"]);
  });
});

describe("makeBrowserTools (human took over)", () => {
  it("blocks every browser tool while human controls", async () => {
    const tools = makeBrowserTools(mockController({ controller: "human" }), rules);
    for (const name of ["navigate", "click", "fill", "extract_links", "get_page_text"]) {
      const input = name === "navigate" ? { url: "https://t.com/x" } : name === "fill" ? { selector: "#a", value: "v" } : name === "click" ? { selector: "#a" } : {};
      const res = await tool(tools, name).execute(input);
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/等待交回|人正在操作/);
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/browser-tools.test.ts`
Expected: FAIL —— browser-tools 模块不存在。

- [ ] **Step 3: 写 `packages/extension/src/browser-tools.ts`**

```ts
import { checkScope } from "@traceforge/tool-resolver";
import type { ScopeRule } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export interface BrowserController {
  controllerIs(c: "llm" | "human"): boolean;
  navigate(url: string): Promise<{ ok: boolean; content: string }>;
  click(selector: string): Promise<{ ok: boolean; content: string }>;
  fill(selector: string, value: string): Promise<{ ok: boolean; content: string }>;
  extractLinks(): Promise<string[]>;
  getPageText(): Promise<string>;
}

const HUMAN_BUSY = "人正在操作浏览器，请等待交回后再操作。";

export function makeBrowserTools(session: BrowserController, scopeRules: ScopeRule[]): ToolDescriptor[] {
  const requireLlm = (): { ok: false; content: string } | null =>
    session.controllerIs("llm") ? null : { ok: false, content: HUMAN_BUSY };

  return [
    {
      name: "navigate",
      description: "在共享浏览器中导航到一个 URL（目标必须在授权范围内）。",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      risk: "normal", source: "builtin",
      execute: async (input) => {
        const blocked = requireLlm(); if (blocked) return blocked;
        const { url } = input as { url: string };
        const verdict = checkScope(url, scopeRules);
        if (!verdict.allowed) return { ok: false, content: `out of scope: ${verdict.reason}` };
        return session.navigate(url);
      },
    },
    {
      name: "click",
      description: "在共享浏览器当前页点击一个 CSS 选择器。",
      inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
      risk: "normal", source: "builtin",
      execute: async (input) => {
        const blocked = requireLlm(); if (blocked) return blocked;
        return session.click((input as { selector: string }).selector);
      },
    },
    {
      name: "fill",
      description: "在共享浏览器当前页向一个表单字段填值。",
      inputSchema: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } }, required: ["selector", "value"] },
      risk: "normal", source: "builtin",
      execute: async (input) => {
        const blocked = requireLlm(); if (blocked) return blocked;
        const { selector, value } = input as { selector: string; value: string };
        return session.fill(selector, value);
      },
    },
    {
      name: "extract_links",
      description: "提取共享浏览器当前页的所有链接。",
      inputSchema: { type: "object", properties: {} },
      risk: "normal", source: "builtin",
      execute: async () => {
        const blocked = requireLlm(); if (blocked) return blocked;
        const links = await session.extractLinks();
        return { ok: true, content: links.join("\n") || "（无链接）" };
      },
    },
    {
      name: "get_page_text",
      description: "获取共享浏览器当前页的可见文本。",
      inputSchema: { type: "object", properties: {} },
      risk: "normal", source: "builtin",
      execute: async () => {
        const blocked = requireLlm(); if (blocked) return blocked;
        const text = await session.getPageText();
        return { ok: true, content: text };
      },
    },
  ];
}
```

- [ ] **Step 4: 扩展 `packages/extension/src/index.ts`**

```ts
export { makeBrowserTools, type BrowserController } from "./browser-tools.js";
```

- [ ] **Step 5: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/extension && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: browser-tools 测试 + 既有 extension 测试全绿；tsc 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): add browser tools gated by control lock and scope guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: server —— BrowserSession（控制权锁状态机 + 真实有头浏览器）

**Files:**
- Create: `apps/server/src/browser-session.ts`
- Test: `apps/server/src/browser-session.test.ts`

**Interfaces:**
- Consumes: `chromium`（playwright）、`checkScope`（tool-resolver）、`ScopeRule`/`TrafficEntry`（shared）、`EventBus`、`TrafficStore`。
- Produces：
  - `class BrowserSession implements BrowserController`（满足 extension 的结构接口）：
    - 构造 `(caseId, scopeRules, traffic: TrafficStore, bus: EventBus)`
    - `async start(): Promise<void>` —— `chromium.launch({ headless: false })` + newPage + `page.on("response")` 监听（受 scope 过滤，进 traffic store + emit response_captured）
    - `async stop(): Promise<void>` —— browser.close + emit browser_stopped
    - `acquireByHuman()` / `releaseToLlm()` —— 切 controller + emit browser_control_changed
    - `controllerIs(c)` / `controller(): "llm" | "human"` / `currentUrl()`
    - `navigate/click/fill/extractLinks/getPageText` —— 操作 page（navigate 内 emit browser_navigated）
  - **可单测部分**：控制权锁状态机（不调真实 playwright 的方法）。为可测，把控制权逻辑做成不依赖 page 的纯方法。

- [ ] **Step 1: 写失败测试 `apps/server/src/browser-session.test.ts`（只测控制权锁状态机，不起真浏览器）**

```ts
import { describe, it, expect } from "vitest";
import { BrowserSession } from "./browser-session.js";
import { EventBus } from "./event-bus.js";
import { createDb } from "./db/client.js";
import { TrafficStore } from "./stores/traffic-store.js";
import type { ScopeRule, RuntimeEvent } from "@traceforge/shared";

const rules: ScopeRule[] = [{ caseId: "c", allowHosts: ["t.com"], denyHosts: [] }];

function makeSession() {
  const db = createDb(":memory:");
  const bus = new EventBus();
  const events: RuntimeEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const session = new BrowserSession("c", rules, new TrafficStore(db), bus);
  return { session, events };
}

describe("BrowserSession control lock", () => {
  it("defaults to llm control", () => {
    const { session } = makeSession();
    expect(session.controllerIs("llm")).toBe(true);
    expect(session.controllerIs("human")).toBe(false);
  });

  it("human takeover flips control and emits event", () => {
    const { session, events } = makeSession();
    session.acquireByHuman();
    expect(session.controllerIs("human")).toBe(true);
    expect(events.some((e) => e.type === "browser_control_changed" && e.controller === "human")).toBe(true);
  });

  it("release returns control to llm", () => {
    const { session, events } = makeSession();
    session.acquireByHuman();
    session.releaseToLlm();
    expect(session.controllerIs("llm")).toBe(true);
    expect(events.some((e) => e.type === "browser_control_changed" && e.controller === "llm")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run apps/server/src/browser-session.test.ts`
Expected: FAIL —— BrowserSession 不存在。

- [ ] **Step 3: 写 `apps/server/src/browser-session.ts`**

```ts
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { checkScope } from "@traceforge/tool-resolver";
import type { ScopeRule } from "@traceforge/shared";
import type { EventBus } from "./event-bus.js";
import type { TrafficStore } from "./stores/traffic-store.js";

type Controller = "llm" | "human";

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private _controller: Controller = "llm";

  constructor(
    private caseId: string,
    private scopeRules: ScopeRule[],
    private traffic: TrafficStore,
    private bus: EventBus,
  ) {}

  async start(): Promise<void> {
    if (this.browser) return; // 幂等
    this.browser = await chromium.launch({ headless: false });
    this.page = await this.browser.newPage();
    this.page.on("response", (res) => {
      const verdict = checkScope(res.url(), this.scopeRules);
      if (!verdict.allowed) return;
      const entry = {
        id: `traf_${randomUUID()}`, caseId: this.caseId, url: res.url(),
        method: res.request().method(), requestHeaders: res.request().headers(),
        responseStatus: res.status(), responseBody: null as string | null,
        createdAt: new Date().toISOString(),
      };
      this.traffic.add(entry);
      this.bus.emit({ type: "response_captured", entry });
    });
    this.bus.emit({ type: "browser_started", caseId: this.caseId });
  }

  async stop(): Promise<void> {
    if (this.browser) { await this.browser.close(); this.browser = null; this.page = null; }
    this.bus.emit({ type: "browser_stopped", caseId: this.caseId });
  }

  // ---- 控制权锁（纯状态，无 playwright 依赖，可单测）----
  controller(): Controller { return this._controller; }
  controllerIs(c: Controller): boolean { return this._controller === c; }
  acquireByHuman(): void {
    this._controller = "human";
    this.bus.emit({ type: "browser_control_changed", caseId: this.caseId, controller: "human" });
  }
  releaseToLlm(): void {
    this._controller = "llm";
    this.bus.emit({ type: "browser_control_changed", caseId: this.caseId, controller: "llm" });
  }

  currentUrl(): string { return this.page?.url() ?? ""; }

  // ---- 浏览器操作（BrowserController 接口）----
  async navigate(url: string): Promise<{ ok: boolean; content: string }> {
    const verdict = checkScope(url, this.scopeRules);
    if (!verdict.allowed) return { ok: false, content: `out of scope: ${verdict.reason}` };
    if (!this.page) return { ok: false, content: "浏览器未启动" };
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    this.bus.emit({ type: "browser_navigated", caseId: this.caseId, url });
    return { ok: true, content: `已导航到 ${url}（状态见 traffic）` };
  }
  async click(selector: string): Promise<{ ok: boolean; content: string }> {
    if (!this.page) return { ok: false, content: "浏览器未启动" };
    try { await this.page.click(selector, { timeout: 5000 }); return { ok: true, content: `已点击 ${selector}` }; }
    catch (e) { return { ok: false, content: `点击失败：${(e as Error).message}` }; }
  }
  async fill(selector: string, value: string): Promise<{ ok: boolean; content: string }> {
    if (!this.page) return { ok: false, content: "浏览器未启动" };
    try { await this.page.fill(selector, value, { timeout: 5000 }); return { ok: true, content: `已填入 ${selector}` }; }
    catch (e) { return { ok: false, content: `填值失败：${(e as Error).message}` }; }
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
```

> 注：navigate 内也做 Scope Guard（双保险：浏览器工具层 + session 层）。控制权锁的三个方法（controllerIs/acquireByHuman/releaseToLlm）不碰 page，故单测无需起真浏览器。

- [ ] **Step 4: 运行确认通过 + tsc**

Run: `pnpm vitest run apps/server/src/browser-session.test.ts && pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json`
Expected: 控制权锁 3 用例全绿；tsc 退出码 0（playwright `$$eval`/`evaluate` 的 DOM 类型若报错，确认 server tsconfig 的 lib 含 DOM——若不含则在这两个方法上用 `// @ts-expect-error` 或调整 tsconfig lib）。

> 若 tsc 报 `document`/`HTMLAnchorElement` 未定义：server tsconfig 默认无 DOM lib。解决：在 `extractLinks`/`getPageText` 的回调里用 playwright 的字符串求值形式避免 DOM 类型，或给 `apps/server/tsconfig.json` 的 compilerOptions.lib 加 `"DOM"`。优先后者（加 DOM lib），改完复跑。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): add BrowserSession with control lock and headful chromium

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: server —— 浏览器控制路由 + agent 集成 + 删旧 /open

**Files:**
- Modify: `apps/server/src/routes.ts`
- Test: `apps/server/src/routes-browser.test.ts`

**Interfaces:**
- Consumes: `BrowserSession`（Task 3）、`makeBrowserTools`（extension Task 2）、现有 stores/EventBus/AgentRuntime 装配。
- Produces：
  - `Map<string, BrowserSession>` —— server 内存管理（registerRoutes 内）。
  - `POST /api/cases/:id/browser/start` → 建/取 BrowserSession + `session.start()` + 存 map（404 当 case 不存在）。
  - `POST /api/cases/:id/browser/stop` → `session.stop()` + 删 map。
  - `POST /api/cases/:id/browser/takeover` → `session.acquireByHuman()`（404 当无 session）。
  - `POST /api/cases/:id/browser/release` → `session.releaseToLlm()`（404 当无 session）。
  - agent run 路由装配工具集时：若该 case 有 BrowserSession，`for (const t of makeBrowserTools(session, c.scopeRules)) registry.register(t)`。
  - **删除**：`POST /api/cases/:id/open` 路由 + `import { chromium }`（不再直接用）。

- [ ] **Step 1: 写失败测试 `apps/server/src/routes-browser.test.ts`（takeover/release 状态变更；不起真浏览器——start 路由在测试中会真起 chromium，故只测 takeover/release 对一个已注入的 mock，或跳过 start 的真实启动）**

> 测试策略：start 路由会真起 headful chromium（CI/无显示环境会失败），故本测试**不调 start**。改为：直接验证 takeover/release 在"无 session 时返回 404"，以及控制权锁逻辑已由 Task 3 单测覆盖。start/真实浏览器靠端到端手测。

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";

let app: FastifyInstance;
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  registerRoutes(app, db, new EventBus());
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

describe("browser control routes (no real browser)", () => {
  it("takeover returns 404 when no session started", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/browser/takeover` });
    expect(res.statusCode).toBe(404);
  });
  it("release returns 404 when no session started", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/browser/release` });
    expect(res.statusCode).toBe(404);
  });
  it("stop returns 404 when no session started", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/browser/stop` });
    expect(res.statusCode).toBe(404);
  });
  it("the old /open route is removed", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/open`, payload: { url: "https://t.com/" } });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run apps/server/src/routes-browser.test.ts`
Expected: FAIL —— browser 路由不存在（takeover 返回 404 但因路由不存在，且 /open 仍在返回非 404）。

- [ ] **Step 3: 修改 `apps/server/src/routes.ts`**

顶部 import：删 `import { chromium } from "playwright";`，增加：

```ts
import { BrowserSession } from "./browser-session.js";
import { makeBrowserTools } from "@traceforge/extension";
```

删除现有 `POST /api/cases/:id/open` 路由（从 `app.post("/api/cases/:id/open", ...)` 整段删除）。

在 `registerRoutes` 函数体内（stores 初始化后）加：

```ts
  const browserSessions = new Map<string, BrowserSession>();
```

在末尾路由区追加：

```ts
  app.post("/api/cases/:id/browser/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });
    let session = browserSessions.get(id);
    if (!session) {
      session = new BrowserSession(id, c.scopeRules, traffic, bus);
      browserSessions.set(id, session);
    }
    try {
      await session.start();
    } catch (err) {
      browserSessions.delete(id);
      return reply.code(500).send({ error: "browser launch failed", reason: (err as Error).message });
    }
    return { ok: true, controller: session.controller(), url: session.currentUrl() };
  });

  app.post("/api/cases/:id/browser/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = browserSessions.get(id);
    if (!session) return reply.code(404).send({ error: "no browser session" });
    await session.stop();
    browserSessions.delete(id);
    return { ok: true };
  });

  app.post("/api/cases/:id/browser/takeover", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = browserSessions.get(id);
    if (!session) return reply.code(404).send({ error: "no browser session" });
    session.acquireByHuman();
    return { ok: true, controller: session.controller() };
  });

  app.post("/api/cases/:id/browser/release", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = browserSessions.get(id);
    if (!session) return reply.code(404).send({ error: "no browser session" });
    session.releaseToLlm();
    return { ok: true, controller: session.controller() };
  });
```

在 agent run 路由的工具注册处（`registry.register(makeProposeScopeExpansionTool(...))` 之后）追加浏览器工具注册：

```ts
    const browserSession = browserSessions.get(id);
    if (browserSession) {
      for (const t of makeBrowserTools(browserSession, c.scopeRules)) registry.register(t);
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run apps/server/src/routes-browser.test.ts`
Expected: PASS（takeover/release/stop 无 session 404、/open 已删返回 404）。

- [ ] **Step 5: tsc + 全量 server 测试**

Run: `pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json && pnpm vitest run apps/server`
Expected: tsc 退出码 0；server 全部测试通过。**注**：删 /open 后，阶段 1 的 `routes-phase*` 测试若有调用 /open 的需相应处理——经核查现有 server 测试（stores/event-bus/routes-phase2/routes-agent/routes-browser）均不调用 /open（/open 的端到端是手动验证的，无自动化测试依赖），故无需改其它测试。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): add browser control routes, agent integration, remove one-shot /open

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 阶段收尾 —— 全量校验、端到端、README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试 + 构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿；各包构建无错误。

- [ ] **Step 2: 端到端手动验证（真实有头浏览器，需本机有显示环境）**

Run（独立脚本起后端，避开 main.ts 的 import.meta 判断；curl 驱动）:
```bash
# 起后端（注入 LLM key 可选，本步只验证浏览器）：
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('e2e-browser.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 5
CID=$(curl -s -X POST localhost:4000/api/cases -H 'content-type: application/json' -d '{"name":"p-f1","allowHosts":["example.com"]}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "browser start: $(curl -s -X POST localhost:4000/api/cases/$CID/browser/start)"
# → 此时本机应弹出一个真实 Chromium 窗口
echo "takeover: $(curl -s -X POST localhost:4000/api/cases/$CID/browser/takeover)"
echo "release: $(curl -s -X POST localhost:4000/api/cases/$CID/browser/release)"
echo "stop: $(curl -s -X POST localhost:4000/api/cases/$CID/browser/stop)"
# 清理后端 + e2e-browser.sqlite*
```
Expected: browser/start 返回 `{"ok":true,...}` 且**本机弹出真实 Chromium 窗口**；takeover/release 返回对应 controller；stop 关窗口。若配了 LLM，可进一步用 e2e-agent 脚本验证 LLM 调 navigate（端到端，需扩展脚本，留作手动）。

- [ ] **Step 3: 更新 `README.md`**

"当前进度"追加：

```markdown
- 人机共享浏览器（Plan F1 后端）：持久有头 Chromium 会话（每 Case 一个）+ 控制权锁（LLM 默认探索，人随时接管/交回）+ 浏览器工具（navigate/click/fill/extract_links/get_page_text 纳入 agent 工具集，navigate 过 Scope Guard）。人和 LLM 共享同一会话，流量自动进库。取代旧的一次性无头 /open。前端控制 UI 见 Plan F2
```

把测试数量更新为实际值。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README for shared browser backend (Plan F1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：对应共享浏览器 spec 的 Plan F1 全部内容——浏览器事件（Task 1）、浏览器工具（Task 2，受控制权锁 + Scope Guard）、BrowserSession 控制权锁 + 有头浏览器 + 流量监听（Task 3）、控制路由 + agent 集成 + 删 /open（Task 4）。前端（F2）不在本计划。
- **类型一致性**：`BrowserController` 接口在 extension（Task 2）定义，BrowserSession（Task 3）实现它（`controllerIs`/`navigate`/`click`/`fill`/`extractLinks`/`getPageText` 签名一致），routes（Task 4）`makeBrowserTools(session, scopeRules)` 传入。浏览器事件 Task 1 定义、Task 3 emit。`session.controller()` 返回类型 `"llm"|"human"` 在路由响应用。
- **安全约束落点**：(a) 控制权锁——浏览器工具 execute 先 controllerIs(Task 2，人接管时 5 工具全挡的测试守住）；(b) Scope Guard——navigate 在工具层（Task 2 越界测试）+ session 层（Task 3 双保险）；(c) 流量监听也过 scope（Task 3 page.on 内 checkScope）。
- **可测/不可测边界**：控制权锁状态机纯逻辑可单测（Task 3，不起真浏览器）；浏览器工具锁逻辑用 mock controller 单测（Task 2）；路由的无-session-404 可 inject 测（Task 4，不调 start 故不起真浏览器）；真实有头浏览器 navigate/click 靠端到端手测（Task 5）。
- **删 /open 的安全性**：现有 server 自动化测试均不依赖 /open（核查：stores/event-bus/routes-phase2/routes-agent 不调它），删除不破坏测试。
- **已知简化**：BrowserSession 重复 start 幂等返回；浏览器工具只 5 个核心动作（截图/上传等留待需要时加）；前端 F2 单独 plan；DOM 类型靠 server tsconfig 加 DOM lib 解决（Task 3 Step 4 注）。
