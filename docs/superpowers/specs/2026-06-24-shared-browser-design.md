# TraceForge 人机共享浏览器 设计文档

> 状态：设计已确认，待拆分为 Plan F1（后端）与 Plan F2（前端）两个实施计划。

## 1. 目标与背景

把"抓流量"从一次性无头访问（当前 `/open`：launch→goto→close）重构为**一个持久的、有头的、人机共享的浏览器会话**。LLM 默认自主探索（导航/点击/提取），遇到搞不定的（登录、验证码、需人判断）人随时"接管"在同一个真窗口里操作，完成后"交回"让 LLM 继续。这是设计文档第 3.4 / 10.2 节"人像正常渗透一样操作目标、AI 实时观察、人可实时介入"的真正落地。

**关键现实约束**：后端跑在用户本机，有头 Chromium 真窗口在用户眼前弹出。用户与 LLM 操作同一个 Playwright `page`，会话/cookie 完全共享。

**Case 概念**：Case = 一次渗透测试任务/项目，是顶层工作空间（含授权范围、流量、Facts、Tasks、Actions、Timeline，按 case_id 隔离）。浏览器会话属于某个 Case，每 Case 一个。

## 2. 整体架构

```
┌─────────────────────────────────────────────────────┐
│ BrowserSession（新，每 Case 一个）                     │
│ 有头 Chromium 真窗口 + 控制权锁                        │
│ - 持久会话：一个 Case 期间一直活着，cookie/会话保持    │
│ - 控制权锁：LLM 默认持有，人"接管"抢锁                  │
│ - 流量监听：page.on("response") → 实时进 traffic store │
└──────────┬──────────────────────────┬────────────────┘
           │ LLM 持锁时调               │ 人接管时操作真窗口
┌──────────▼──────────┐    ┌───────────▼────────────────┐
│ 浏览器工具（新）       │    │ 人直接在真 Chrome 窗口操作    │
│ navigate/click/fill/ │    │ 点击/填表单/登录（同一会话）  │
│ extract_links/...    │    └─────────────────────────────┘
└──────────────────────┘
           │
┌──────────▼──────────────────────────────────────────┐
│ Scope Guard：navigate 目标必过授权范围（越界拒绝）      │
└──────────────────────────────────────────────────────┘

前端：浏览器状态条（控制权在谁/当前 URL）+ 启动/停止/接管/交回按钮
      （不镜像画面——真窗口在眼前）
```

**核心**：
- **三方共享一个 page**：LLM 工具、人的接管操作、流量监听都作用于同一个 Playwright `page` → 会话/cookie 完全一致，这是"人机共用浏览器"的实现。
- **流量自动进库**：`page.on("response")` 不管谁操作产生的流量都实时进 traffic store + emit `response_captured`，前端 Traffic 面板与 agent 的 `list_traffic` 都能看到。
- **替换旧 `/open`**：删一次性无头访问，换成持久会话 + 工具驱动 + 人可接管。
- **两道门不变**：navigate 经 Scope Guard；浏览器工具是 normal 风险（不卡确认门，但受控制权锁）。

## 3. BrowserSession + 控制权锁

```ts
type Controller = "llm" | "human";

class BrowserSession {
  private browser: Browser;   // chromium.launch({ headless: false })
  private page: Page;
  private controller: Controller = "llm";  // 默认 LLM 持锁

  async start(caseId, scopeRules, bus): Promise<void>  // 起有头窗口 + page.on("response") 流量监听
  async stop(): Promise<void>

  acquireByHuman(): void   // 人接管：controller="human"，emit browser_control_changed
  releaseToLlm(): void     // 人交回：controller="llm"
  controllerIs(c: Controller): boolean

  // 受锁操作（仅 controller==="llm" 时允许；navigate 额外过 Scope Guard）
  async navigate(url: string): Promise<{ ok: boolean; content: string }>
  async click(selector: string): Promise<{ ok: boolean; content: string }>
  async fill(selector: string, value: string): Promise<{ ok: boolean; content: string }>
  async extractLinks(): Promise<string[]>
  async getPageText(): Promise<string>
  currentUrl(): string
}
```

**控制权锁工作方式**：

```
默认 controller="llm"
LLM 调浏览器工具 → 工具检查 controllerIs("llm")：
   是 → 执行
   否（人接管中）→ 返回 {ok:false, content:"人正在操作浏览器，请等待交回"}
                  → LLM 看到，自己停下等或做别的（agent loop 自然处理）
人点"接管" → acquireByHuman() → 此后 LLM 浏览器工具被挡
   → 人在真窗口自由操作（登录等）
人点"交回" → releaseToLlm() → LLM 恢复
```

**关键点**：
- **锁只挡浏览器工具**：人接管时，LLM 仍能调非浏览器工具（record_fact、list_traffic、http_replay）——可一边等人登录，一边分析已有流量。
- **人的操作不受锁限制**：人随时能在真窗口点击（OS 层面），"接管"只是告诉系统别让 LLM 动浏览器。
- **会话级管理**：server 维护 `Map<caseId, BrowserSession>`。

## 4. 浏览器工具

`@traceforge/extension` 新增 `browser-tools.ts`，工厂函数注入 BrowserSession（结构接口，extension 不依赖 server）。全 normal 风险。

| 工具 | 做什么 | 锁/门 |
|---|---|---|
| `navigate` | 导航到 URL | 控制权锁 + **Scope Guard**（越界拒） |
| `click` | 点击选择器 | 控制权锁 |
| `fill` | 填表单字段 | 控制权锁 |
| `extract_links` | 提取当前页所有链接 | 控制权锁（读） |
| `get_page_text` | 取当前页文本 | 控制权锁（读） |

每个 execute 先 `session.controllerIs("llm")`，否则返回"请等待交回"。`navigate` 额外 `checkScope`。agent 启动时若 BrowserSession 存在则连同 case 工具集一起注册。

注入接口（结构类型）：
```ts
interface BrowserController {
  controllerIs(c: "llm" | "human"): boolean;
  navigate(url: string): Promise<{ ok: boolean; content: string }>;
  click(selector: string): Promise<{ ok: boolean; content: string }>;
  fill(selector: string, value: string): Promise<{ ok: boolean; content: string }>;
  extractLinks(): Promise<string[]>;
  getPageText(): Promise<string>;
}
```

## 5. server 路由与事件

**新增路由**（routes.ts）：
- `POST /api/cases/:id/browser/start` → 建 BrowserSession（有头窗口弹出）+ 流量监听 + emit `browser_started`，注册到 `Map<caseId, BrowserSession>`
- `POST /api/cases/:id/browser/stop` → `session.stop()` + 移除
- `POST /api/cases/:id/browser/takeover` → `acquireByHuman()` + emit `browser_control_changed`
- `POST /api/cases/:id/browser/release` → `releaseToLlm()` + emit `browser_control_changed`

**删除**：旧 `POST /api/cases/:id/open`（一次性无头）及前端调用、`chromium` 在 `/open` 的用法。

**agent 路由集成**：`/agent/run` 装配工具集时，若该 case 有 BrowserSession，则注册浏览器工具（注入该 session）。

**新事件**（events.ts）：
- `browser_started` { caseId }
- `browser_stopped` { caseId }
- `browser_control_changed` { caseId, controller: "llm" | "human" }
- `browser_navigated` { caseId, url }

流量仍走现有 `response_captured`。

## 6. 前端（占位 UI）

> 前端整体仍是裸占位 UI——核心能力（浏览器/插件/MCP）全通后再整体设计多面板工作台。本计划只用裸按钮/状态条把浏览器控制跑通。

- "抓流量"区改为"浏览器"区：**启动浏览器** / **停止** 按钮；状态条显示「控制权：LLM/人 + 当前 URL」；**接管** / **交回** 按钮。
- 删除旧"Open URL"输入（一次性访问）及 `openUrl` api。
- Traffic 面板保留（靠现有 `response_captured` 事件刷新——人和 LLM 操作产生的流量都出现）。
- store 加 `browserController: "llm" | "human" | null`、`browserUrl: string`，WS 处理 `browser_started`/`browser_stopped`/`browser_control_changed`/`browser_navigated`。

## 7. 错误处理

- 浏览器工具在人接管时返回 `{ok:false}`，LLM 自处理（不崩）。
- navigate 越界 → Scope Guard 拒，返回 `{ok:false, content:"out of scope"}`。
- 选择器找不到 / 页面加载失败 → catch 后返回 `{ok:false, content:错误}`，LLM 换路。
- BrowserSession 已存在时重复 start → 返回现有会话状态（幂等）。
- start 时 Chromium 启动失败（无显示环境等）→ 路由捕获，返回 500 + 错误信息。

## 8. 测试

- **BrowserSession 控制权锁单测**（纯状态机，不起真浏览器）：默认 controller=llm、acquireByHuman → human、releaseToLlm → llm、controllerIs。
- **浏览器工具锁逻辑单测**（注入 mock BrowserController）：LLM 持锁时工具执行；人接管时工具返回"请等待交回"；navigate 越界返回 out of scope。
- **真实有头浏览器**的 navigate/click/extract 不单测（要起真窗口），靠端到端手动验证。
- 控制权切换路由（takeover/release）的状态变更可 inject 测试。

## 9. 实现分解（两个独立 plan）

```
Plan F1（后端，先行）:
  BrowserSession（持久有头会话 + 控制权锁 + 流量监听）
  + 浏览器工具（navigate/click/fill/extract_links/get_page_text）
  + browser/start|stop|takeover|release 路由 + 新事件
  + agent 路由集成浏览器工具
  + 删旧 /open
  + 控制权锁与工具锁单测
  → 后端可用：curl 启动浏览器、真窗口弹出、agent 能导航

Plan F2（前端，占位 UI）:
  浏览器控制区（启动/停止/接管/交回 + 状态条）替换旧 Open UI
  + store 浏览器状态 + WS 处理
  → 人能在前端启动浏览器、接管/交回
```

Plan F1 先做（后端闭环，curl/真窗口可验证），F2 在其上做前端控制。

## 10. 核心理念落点（自检）

- **人机协同**：LLM 默认自主探索，人随时接管（控制权锁），共享同一会话——设计文档 3.4/10.2 灵魂。
- **LLM 主导**：浏览器作为工具纳入 agent 工具集，LLM 自主调用导航/点击/提取。
- **零硬编码**：浏览器工具领域无关（导航/点击/提取，不含漏洞逻辑）。
- **安全边界**：navigate 经 Scope Guard（发包守授权范围）；浏览器工具受控制权锁。
- **流量即观察**：人和 LLM 操作产生的流量都实时进库 + 事件，agent 与前端都能看到。
- **会话即状态**：持久 page 对象承载会话/cookie，人机共享。
