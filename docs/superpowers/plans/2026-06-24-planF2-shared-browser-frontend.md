# Plan F2：人机共享浏览器前端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（当前会话直接执行）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 前端把旧的一次性 "Open URL" 占位换成共享浏览器控制区：启动/停止/接管/交回 4 个按钮 + 控制权状态条（控制权在 LLM/人 + 当前 URL）。Traffic 面板保留（靠现有 `response_captured` 事件刷新——人和 LLM 操作产生的流量都出现）。对应共享浏览器 spec（docs/superpowers/specs/2026-06-24-shared-browser-design.md）第 6 节。

**Architecture:** `apps/web/src/api.ts` 删 `openUrl`、加 `startBrowser/stopBrowser/takeoverBrowser/releaseBrowser`。`store.ts` 加 `browserController: "llm" | "human" | null`、`browserUrl: string`，WS 处理 4 个浏览器事件。`App.tsx` 把"抓流量"区的 Open 输入框换成浏览器控制区。

**Tech Stack:** React + zustand + Vite（沿用），无前端单测（裸占位 UI，靠 `pnpm -r build` + 手动验证）。

## Global Constraints

- 沿用既有约束：TypeScript strict、ESM、`@traceforge/shared` 单源类型。
- 前端无自动化测试框架（apps/web 无 vitest）；本计划以 `pnpm --filter @traceforge/web build`（tsc + vite）作为校验门，外加端到端手动验证。
- **占位 UI 原则**：只用裸按钮/状态条把浏览器控制跑通，不做整体工作台设计（核心能力全通后再统一设计）。
- 后端路由已就绪（Plan F1）：`POST /api/cases/:id/browser/{start,stop,takeover,release}`，事件 `browser_started`/`browser_stopped`/`browser_control_changed`/`browser_navigated`。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: api.ts —— 浏览器控制 API（删 openUrl）

**Files:**
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Consumes: 后端 4 个 browser 路由。
- Produces：`startBrowser(caseId)`/`stopBrowser(caseId)`/`takeoverBrowser(caseId)`/`releaseBrowser(caseId)` 各返回 `Promise<Response>`；删除 `openUrl`。

- [ ] **Step 1: 删除 `openUrl`，加 4 个浏览器控制函数**

把 `apps/web/src/api.ts` 中的 `openUrl` 函数整段删除，在原位置替换为：

```ts
export async function startBrowser(caseId: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/browser/start`, { method: "POST" });
}
export async function stopBrowser(caseId: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/browser/stop`, { method: "POST" });
}
export async function takeoverBrowser(caseId: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/browser/takeover`, { method: "POST" });
}
export async function releaseBrowser(caseId: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/browser/release`, { method: "POST" });
}
```

- [ ] **Step 2: tsc 校验（随 Task 3 一起 build；本步只目测无残留 openUrl 引用）**

Run: `grep -rn "openUrl" apps/web/src`
Expected: 仅可能在 App.tsx（Task 3 会清）；api.ts 内无 openUrl。

---

### Task 2: store.ts —— 浏览器状态 + WS 处理

**Files:**
- Modify: `apps/web/src/store.ts`

**Interfaces:**
- Consumes: 现有 `useStore`、`RuntimeEvent`。
- Produces：State 加 `browserController: "llm" | "human" | null`、`browserUrl: string`、`setBrowser(controller, url?)`、`resetBrowser()`；WS 处理 `browser_started`/`browser_stopped`/`browser_control_changed`/`browser_navigated`。

- [ ] **Step 1: 在 State 接口加字段与方法**

在 `interface State` 中 `pendingApproval` 行后加：

```ts
  browserController: "llm" | "human" | null;
  browserUrl: string;
```

在方法区（`clearPendingApproval` 行后）加：

```ts
  setBrowser: (controller: "llm" | "human" | null, url?: string) => void;
  resetBrowser: () => void;
```

- [ ] **Step 2: 在 store 实现里加初值、方法、setCase 重置**

在 `pendingApproval: null,`（初值）行后加：

```ts
  browserController: null,
  browserUrl: "",
```

把 `setCase` 改为同时重置浏览器状态（在它 set 的对象里加 `browserController: null, browserUrl: ""`）：

```ts
  setCase: (id) => set({ caseId: id, traffic: [], facts: [], tasks: [], timeline: [], actions: [], decisions: [], agentEvents: [], pendingApproval: null, browserController: null, browserUrl: "" }),
```

在 `clearPendingApproval` 实现行后加：

```ts
  setBrowser: (controller, url) => set((s) => ({ browserController: controller, browserUrl: url ?? s.browserUrl })),
  resetBrowser: () => set({ browserController: null, browserUrl: "" }),
```

- [ ] **Step 3: WS 处理 4 个浏览器事件**

在 `ws.onmessage` 的 else-if 链末尾（`approval_resolved` 行后）加：

```ts
      else if (event.type === "browser_started" && event.caseId === cid) get().setBrowser("llm");
      else if (event.type === "browser_stopped" && event.caseId === cid) get().resetBrowser();
      else if (event.type === "browser_control_changed" && event.caseId === cid) get().setBrowser(event.controller);
      else if (event.type === "browser_navigated" && event.caseId === cid) get().setBrowser(get().browserController, event.url);
```

---

### Task 3: App.tsx —— 浏览器控制区替换 Open UI

**Files:**
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: store 的 `browserController`/`browserUrl`、api 的 `startBrowser`/`stopBrowser`/`takeoverBrowser`/`releaseBrowser`。
- Produces：UI 上"抓流量"区改为"共享浏览器"区（启动/停止/接管/交回 + 状态条），Traffic 表保留。

- [ ] **Step 1: 改 import**

把第 3 行：
```ts
import { createCase, openUrl, runAgent, resolveApproval } from "./api.js";
```
改为：
```ts
import { createCase, startBrowser, stopBrowser, takeoverBrowser, releaseBrowser, runAgent, resolveApproval } from "./api.js";
```

- [ ] **Step 2: 从 useStore 解构出浏览器状态**

把 useStore 解构（第 6-9 行那块）里的：
```ts
    agentEvents, pendingApproval, setCase, connectWs, resetAgent,
```
改为：
```ts
    agentEvents, pendingApproval, browserController, browserUrl, setCase, connectWs, resetAgent,
```

- [ ] **Step 3: 删除 url 局部 state**

删除第 12 行：
```ts
  const [url, setUrl] = useState("https://example.com/");
```

- [ ] **Step 4: 把"抓流量"区换成"共享浏览器"区**

把这段（`<h2>抓流量</h2>` 起到 `</table>` 前的 Open 输入/按钮）：

```tsx
      <h2>抓流量</h2>
      <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 360 }} />
      <button onClick={() => openUrl(caseId, url)}>Open</button>
```

替换为：

```tsx
      <h2>共享浏览器</h2>
      <div style={{ margin: "8px 0", display: "flex", gap: 8, alignItems: "center" }}>
        {browserController === null ? (
          <button onClick={() => startBrowser(caseId)}>启动浏览器</button>
        ) : (
          <>
            <button onClick={() => stopBrowser(caseId)}>停止</button>
            {browserController === "llm" ? (
              <button onClick={() => takeoverBrowser(caseId)}>接管</button>
            ) : (
              <button onClick={() => releaseBrowser(caseId)}>交回 LLM</button>
            )}
            <span style={{ padding: "2px 8px", borderRadius: 4, background: browserController === "human" ? "#ffe0b2" : "#c8e6c9" }}>
              控制权：{browserController === "human" ? "人" : "LLM"}
            </span>
            <span style={{ color: "#555", fontSize: 13 }}>当前：{browserUrl || "about:blank"}</span>
          </>
        )}
      </div>
```

> 状态条只在浏览器启动后显示；接管/交回按钮按控制权切换；真窗口在用户眼前，不镜像画面。

- [ ] **Step 5: 校验 build（tsc + vite）**

Run: `pnpm --filter @traceforge/web build`
Expected: tsc 无类型错（无残留 `openUrl`/`url`/`setUrl` 引用），vite 构建成功。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): shared browser control UI (start/stop/takeover/release + status bar)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 收尾 —— 端到端手动验证 + README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量 build**

Run: `pnpm -r build`
Expected: 全绿。

- [ ] **Step 2: 端到端手动验证（真实有头浏览器 + 前端控制）**

起后端 + 前端 dev，浏览器开 http://localhost:5173：
1. Create Case（allowHosts: example.com）
2. 点"启动浏览器" → 本机弹出真实 Chromium 窗口，状态条显示「控制权：LLM / 当前：about:blank」
3. 点"接管" → 状态条变「控制权：人」（人此时可在真窗口操作）
4. 点"交回 LLM" → 状态条回「控制权：LLM」
5. 点"停止" → 窗口关闭，控制区回到"启动浏览器"

> 注：main.ts 的 import.meta 判断在 Windows 下不触发 listen，用独立脚本起后端（见 Plan F1 Task 5 Step 2）。

- [ ] **Step 3: 更新 README**

"当前进度"标题加 F2，并在 F1 行后追加：

```markdown
- 人机共享浏览器（Plan F2 前端）：浏览器控制区（启动/停止/接管/交回）+ 控制权状态条（LLM/人 + 当前 URL）替换旧的一次性 Open UI。Traffic 面板靠 response_captured 事件实时刷新（人和 LLM 操作产生的流量都出现）
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README for shared browser frontend (Plan F2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：对应 spec 第 6 节全部——浏览器区替换 Open UI（Task 3）、4 个控制按钮 + 状态条（Task 3）、store 浏览器状态 + WS 处理（Task 2）、删 openUrl api（Task 1）、Traffic 面板保留（未动，靠现有 response_captured）。
- **类型一致性**：`browserController: "llm" | "human" | null` 在 store（Task 2）定义，App（Task 3）消费；`setBrowser(controller, url?)` 签名一致；4 个 api 函数（Task 1）名与 App（Task 3）调用名一致。
- **无前端单测**：apps/web 无 vitest，校验门为 build（tsc + vite，Task 3 Step 5 / Task 4 Step 1）+ 端到端手动（Task 4 Step 2）。
- **删 openUrl 的安全性**：后端 /open 已在 F1 删除；前端删 openUrl 后无残留引用（Task 1 Step 2 grep 守）。
