# 整体照搬 demo 样式 实施计划（图谱重做 第 3 轮 / 共 3 轮 · 收尾）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（当前会话直接执行）。Steps use checkbox (`- [ ]`) syntax for tracking。

**Goal:** 把整个工作台 UI 照 flow/ demo 重做：以 demo 的 styles.css 为样式基底重写 app.css，所有组件结构改成 demo 那套 class（.topbar/.workspace/.panel/.request-row/.message/.composer…），演示专用部分（重放控件/写死 run id/假导航）换成我们的真功能，去掉第 2 轮图谱的 .tf-graph 作用域使整体浅色统一。对应 spec docs/superpowers/specs/2026-06-26-demo-styling-design.md。

**Architecture:** app.css 移植 demo styles.css（保留我们的 Geist+Noto 字体，加我们特有的 Select/确认卡/统计徽章浅色类）。App.tsx 用 demo 的 `.app-shell`/`.topbar`/`.workspace` 三栏壳；TopBar/Traffic/Browser/Agent/Knowledge/各 Tab/Select/CaseLauncher 逐个换成 demo class 与 DOM 结构。GraphView 去 `.tf-graph` 作用域。后端零改动、数据流不变（只换 className 与少量 JSX）。

**Tech Stack:** React 18 + zustand + Vite（沿用），@xyflow/react+elkjs（第 2 轮），Geist+Noto 字体、@phosphor-icons（沿用）。

## Global Constraints

- **照 demo 质量**：app.css 以 flow/src/styles.css 为蓝本移植（用户认可的现成样式），不再自拟。组件结构对齐 flow/src/App.tsx 的 class。
- **演示专用换真功能**：重放控件（播放/进度/1x2x4x）删掉；写死 run id 换控制权状态；假导航 Run/Evidence/Reports 换 Case 选择+新建+统计徽章；mock 数据换 store 真实数据。
- **整体浅色**：去第 2 轮图谱 `.tf-graph` 作用域，整个工作台浅色统一。
- **数据/功能不变**：后端零改动；store/WS/各组件交互逻辑不变，只换样式 class + 少量 JSX 结构。
- **字体**：保留已装 Geist Sans/Mono + Noto Sans SC（比 demo 系统字体精致），`--font` 用它们。
- **缺字段省略**：我们无而 demo 有的（流量 size/latency）→ 省略 DOM 不留空位；demo 有而我们无的（重放）→ 不实现。
- **前端无测试框架**：靠 tsc + `pnpm --filter @traceforge/web build` + 端到端手测；后端 `pnpm test` 仍全绿（169）。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

**蓝本文件**（执行时对照读）：`flow/src/styles.css`（全部样式）、`flow/src/App.tsx`（TrafficPanel/ChatPanel/GraphPanel/Workbench 的 JSX 结构与 class）。

---

### Task 1: app.css —— 移植 demo styles.css 为基底

**Files:**
- Rewrite: `apps/web/src/app.css`

**Interfaces:**
- Produces：demo 的全部组件类（`.app-shell`/`.topbar`/`.brand`/`.run-id`/`.workspace`/`.panel`/`.panel-header`/`.section-kicker`/`.traffic-panel`/`.browser-button`/`.browser-strip`/`.request-row`/`.request-top`/`.request-meta`/`.method`/`.chat-panel`/`.session-state`/`.objective-block`/`.messages`/`.message`/`.tool-strip`/`.composer`/`.graph-panel`/`.graph-header`/`.graph-count`/`.graph-canvas`/`.flow-card*`/`.edge-label`）+ 我们特有的浅色类（`.tf-select*`/`.tf-confirm*`/`.tf-stat*`/`.tf-guide*`）。

- [ ] **Step 1: 读 demo 样式蓝本**

Run: `cat flow/src/styles.css`
（作为本任务的移植源，逐块抄。）

- [ ] **Step 2: 重写 `apps/web/src/app.css`**

整体替换为：以 flow/src/styles.css 全文为基底，做三处适配——
1. `:root` 的字体改用我们的：把 demo 的 `font-family: ui-sans-serif,...` 那段 + 新增 `--font: "Geist Sans","Noto Sans SC",system-ui,sans-serif;` `--mono: "Geist Mono",ui-monospace,monospace;`，并把 demo 里所有 `font-family:"SFMono-Regular",...` 替换为 `var(--mono)`，body/根字体用 `var(--font)`。
2. 删掉 demo 的 `.replay-controls`/`.current-event`/`.graph-footer` 里属于重放控件的样式（重放不做）——保留 `.graph-footer` 容器但内容由我们换。实际：保留 `.graph-panel` 改为 `grid-template-rows: auto minmax(0,1fr)`（去掉 118px 的 footer 行）。
3. 末尾追加我们特有组件的浅色类（demo 没有）：

```css
/* 我们特有：Case 下拉（浅色） */
.tf-select { position: relative; }
.tf-select-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: #182230; font-size: 13px; font-weight: 600; cursor: pointer; }
.tf-select-trigger:hover { border-color: var(--line-strong); }
.tf-select-trigger.is-open { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
.tf-select-ph { color: var(--faint); }
.tf-select-caret { color: var(--muted); transition: transform .12s ease; }
.tf-select-trigger.is-open .tf-select-caret { transform: rotate(180deg); }
.tf-select-menu { position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 30; background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 5px; box-shadow: 0 16px 40px rgba(22,24,29,0.14); animation: tf-pop .1s ease; max-height: 280px; overflow: auto; }
@keyframes tf-pop { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
.tf-select-opt { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 7px 9px; border: 0; border-radius: 7px; background: none; color: #182230; font-size: 13px; text-align: left; cursor: pointer; }
.tf-select-opt:hover { background: #f4f6f9; }
.tf-select-opt.is-sel { color: var(--accent); }
.tf-select-empty { padding: 9px; color: var(--faint); font-size: 12.5px; text-align: center; }

/* 我们特有：统计徽章 + 控制权 pill（顶栏右） */
.tf-stat { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); }
.tf-stat b { color: #182230; font-family: var(--mono); font-weight: 600; }
.tf-stat.is-alert, .tf-stat.is-alert b { color: var(--amber); }
.tf-stat.is-crit, .tf-stat.is-crit b { color: var(--red); }
.tf-pill { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 1px solid var(--line); border-radius: 999px; background: #fff; color: #182230; font-size: 12px; font-weight: 600; }
.tf-pill.is-llm { color: var(--accent); border-color: #c7d7fe; }
.tf-pill.is-human { color: var(--amber); border-color: #fedf89; }

/* 我们特有：确认卡（审批/scope，浅色） */
.tf-confirm { border: 1px solid var(--line); border-radius: 10px; padding: 13px 14px; margin: 2px 0 12px; background: #fff; box-shadow: 0 8px 22px rgba(22,24,29,0.08); }
.tf-confirm-warn { border-color: #fedf89; background: #fffcf5; }
.tf-confirm-info { border-color: #c7d7fe; background: #f8fbff; }
.tf-confirm-head { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; font-size: 12.5px; font-weight: 700; }
.tf-confirm-warn .tf-confirm-head { color: var(--amber); }
.tf-confirm-info .tf-confirm-head { color: var(--accent); }
.tf-confirm-body { font-size: 12.5px; color: #1d2939; line-height: 1.6; }
.tf-confirm-reason { font-size: 12px; color: var(--muted); margin-top: 5px; }
.tf-confirm-code { display: block; margin: 9px 0; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: #f8fafc; color: #182230; font-family: var(--mono); font-size: 11.5px; word-break: break-all; }
.tf-confirm-inline { font-family: var(--mono); font-size: 11.5px; color: var(--accent); background: #eef4ff; border-radius: 5px; padding: 1px 6px; }
.tf-confirm-actions { display: flex; gap: 8px; margin-top: 12px; }

/* 我们特有：引导空状态（浅色） */
.tf-guide { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; min-height: 180px; padding: 28px 20px; text-align: center; color: var(--muted); }
.tf-guide-icon { display: grid; place-items: center; width: 46px; height: 46px; border: 1px solid var(--line); border-radius: 13px; background: #fff; color: var(--accent); box-shadow: 0 4px 14px rgba(22,24,29,0.06); }
.tf-guide-title { font-size: 14px; font-weight: 700; color: #182230; }
.tf-guide-hint { max-width: 260px; font-size: 12.5px; line-height: 1.65; }
.tf-empty { color: var(--faint); font-size: 12.5px; line-height: 1.6; }

/* 通用 button（demo 的 button 已含，补一个 accent 主按钮 + tabs + 图谱详情侧栏浅色） */
.tf-btn { height: 30px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: #344054; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.tf-btn:hover { background: #f8fafc; }
.tf-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.tf-btn-accent { border-color: transparent; background: var(--accent); color: #fff; }
.tf-btn-accent:hover { background: #1d4ed8; }
.tf-btn-icon { display: inline-flex; align-items: center; gap: 6px; }
.tf-tabs { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.tf-tab { padding: 5px 10px; border: 0; border-radius: 7px; background: none; color: var(--muted); font-size: 12.5px; font-weight: 600; cursor: pointer; }
.tf-tab:hover { background: #f4f6f9; color: #182230; }
.tf-tab.active { color: var(--accent); background: #eef4ff; }
.tf-row { padding: 7px 0; border-bottom: 1px solid #eef1f4; font-size: 12.5px; color: #1d2939; }
.tf-row:last-child { border-bottom: none; }
.tf-tag { display: inline-block; margin-right: 7px; padding: 1px 6px; border-radius: 5px; background: #eef4ff; color: var(--accent); font-family: var(--mono); font-size: 10px; }
.tf-gdetail { position: absolute; top: 0; right: 0; bottom: 0; width: 288px; z-index: 5; padding: 14px 16px; overflow: auto; border-left: 1px solid var(--line); background: #fff; box-shadow: -12px 0 30px rgba(22,24,29,0.08); }
.tf-gdetail-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.tf-gdetail-title { font-size: 14px; font-weight: 600; color: #182230; }
.tf-gdetail-id { margin: 4px 0 14px; font-family: var(--mono); font-size: 10.5px; color: var(--faint); word-break: break-all; }
.tf-gdetail-meta { display: flex; flex-direction: column; gap: 6px; padding: 11px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); margin-bottom: 14px; }
.tf-gdetail-kv { display: flex; justify-content: space-between; gap: 12px; font-size: 11.5px; }
.tf-gdetail-kv span:first-child { color: var(--muted); }
.tf-gdetail-kv span:last-child { font-family: var(--mono); color: #182230; word-break: break-all; text-align: right; }
.tf-gdetail-rel { margin-bottom: 12px; }
.tf-gdetail-rel-h { margin-bottom: 6px; font-size: 11px; font-weight: 600; color: var(--muted); }
.tf-gdetail-link { margin-bottom: 5px; padding: 5px 9px; border: 1px solid var(--line); border-radius: 7px; background: #f8fafc; font-family: var(--mono); font-size: 11.5px; color: #182230; }

/* 模态（图谱放大）浅色 */
.tf-modal-bg { position: absolute; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; background: rgba(22,24,29,0.4); backdrop-filter: blur(3px); }
.tf-modal { display: flex; flex-direction: column; width: 86vw; height: 80vh; overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: #fff; box-shadow: 0 30px 80px rgba(22,24,29,0.25); }
```

并把 GraphView 第 2 轮的 `.tf-graph .flow-card` 等作用域样式，去掉 `.tf-graph` 前缀（合并为 demo 的全局 `.flow-card`/`.edge-label`/`.react-flow`——因为整体已浅色，不再需要作用域）。实际：移植 demo styles.css 时它本就含 `.flow-card`/`.edge-label`/`.react-flow` 全局浅色样式，直接用，删掉我们 app.css 里带 `.tf-graph` 前缀的那份。

- [ ] **Step 3: build 确认 app.css 无语法错**

Run: `pnpm --filter @traceforge/web build`
Expected: vite 构建成功（此时组件仍用旧 tf-* 类，下一任务起逐个换；本步只验证 CSS 不报错）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): port demo styles.css as light base for app.css

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: App.tsx + TopBar —— 三栏壳 + 顶栏对齐 demo

**Files:**
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/TopBar.tsx`

**Interfaces:**
- Consumes: demo 的 `.app-shell`/`.topbar`/`.workspace`（Task 1）；CaseLauncher（既有，bar 变体）。
- Produces: 三栏壳 + 顶栏 demo 风。

- [ ] **Step 1: 改 `apps/web/src/App.tsx` 的三栏壳**

把有 case 的 return 改为 demo 的 `.app-shell` + `.workspace`：
```tsx
  return (
    <div className="app-shell">
      <TopBar />
      <section className="workspace">
        <TrafficPanel />
        <AgentPanel />
        <KnowledgePanel />
      </section>
      <GraphModal />
    </div>
  );
```
> 注：demo 三栏顺序是 Traffic / Chat / Graph。我们左栏含 BrowserPanel+TrafficPanel——把 BrowserPanel 并入 TrafficPanel 顶部（Task 3 处理），这里三栏直接 Traffic/Agent/Knowledge。

把无 case 的首屏 return 改为 demo 浅色卡片风（沿用 CaseLauncher hero，但外层用浅色）：
```tsx
  if (!caseId) {
    return (
      <div className="app-shell" style={{ placeItems: "center" }}>
        <div className="onboard">
          <div className="brand"><span><ShieldCheck size={16} /></span><div><strong>TraceForge</strong><small>授权红队工作台</small></div></div>
          <h1 className="onboard-title">漏洞挖掘智能体工作台</h1>
          <p className="onboard-sub">让 AI 像有经验的红队搭档一样自主探索、记录证据、持续推理。你随时介入、把关方向。</p>
          <CaseLauncher variant="hero" />
        </div>
      </div>
    );
  }
```
顶部 import 加 `import { ShieldCheck } from "@phosphor-icons/react";`。并在 app.css 末尾追加 onboard 浅色样式：
```css
.onboard { width: 100%; max-width: 460px; padding: 32px; border: 1px solid var(--line); border-radius: 16px; background: #fff; box-shadow: var(--shadow); }
.onboard-title { margin: 18px 0 0; font-size: 24px; font-weight: 740; color: #182230; letter-spacing: -0.02em; }
.onboard-sub { margin: 10px 0 18px; font-size: 13.5px; line-height: 1.7; color: var(--muted); }
.onboard .brand span { display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 8px; color: #334155; }
```

- [ ] **Step 2: 改 `apps/web/src/components/TopBar.tsx` 用 demo `.topbar`**

```tsx
import { Warning, ShieldCheck, ChevronRight } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { CaseLauncher } from "./CaseLauncher.js";

export function TopBar() {
  const { caseId, browserController, browserUrl, facts, tasks, warnings } = useStore();
  const crit = warnings.filter((w) => w.level === "critical").length;
  const warnCls = crit > 0 ? "is-crit" : warnings.length > 0 ? "is-alert" : "";
  const controlLabel = browserController === "human" ? "人" : browserController === "llm" ? "LLM" : "未启动";
  const controlClass = browserController === "human" ? "is-human" : browserController === "llm" ? "is-llm" : "";
  return (
    <header className="topbar">
      <div className="brand"><span><ShieldCheck size={16} /></span><div><strong>TraceForge</strong><small>授权红队工作台</small></div></div>
      <nav><CaseLauncher variant="bar" /></nav>
      <div className="run-id">
        {caseId && <>
          <span className="tf-stat">Facts <b>{facts.length}</b></span>
          <span className="tf-stat">Tasks <b>{tasks.length}</b></span>
          <span className={`tf-stat ${warnCls}`} title="Observer 提示"><Warning size={13} weight="fill" /> <b>{warnings.length}</b></span>
          <span className={`tf-pill ${controlClass}`}><ShieldCheck size={13} weight="fill" />{controlLabel}{browserUrl && <span style={{ color: "var(--faint)" }}>· {browserUrl}</span>}</span>
        </>}
      </div>
    </header>
  );
}
```
> `ChevronRight` 引入但若未用可删；demo topbar 是 `grid-template-columns: 280px 1fr auto`，nav 居中、run-id 靠右——我们 nav 放 Case 选择、run-id 放统计+控制权。

- [ ] **Step 3: tsc + build**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 0；build 成功（其余面板仍旧类，下一任务换）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): align app shell and topbar to demo (.app-shell/.topbar/.workspace)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: TrafficPanel + BrowserPanel —— 对齐 demo .traffic-panel

**Files:**
- Modify: `apps/web/src/components/TrafficPanel.tsx`, `apps/web/src/components/BrowserPanel.tsx`

**Interfaces:**
- Consumes: demo `.traffic-panel`/`.panel-header`/`.section-kicker`/`.browser-button`/`.browser-strip`/`.request-row`/`.request-top`/`.request-meta`/`.method`（Task 1）。
- Produces: 左栏 = Traffic panel（含 BrowserPanel 的控制并入顶部）。

- [ ] **Step 1: 改 `apps/web/src/components/TrafficPanel.tsx`（含浏览器控制条）**

```tsx
import { Pulse } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { BrowserControls } from "./BrowserPanel.js";

export function TrafficPanel() {
  const { caseId, traffic, browserController, browserUrl } = useStore();
  return (
    <aside className="panel traffic-panel">
      <div className="panel-header">
        <div><span className="section-kicker">Capture</span><h2>流量</h2></div>
        {caseId && <BrowserControls />}
      </div>
      <div className="browser-strip">
        <Pulse size={14} />
        <span>{browserController ? (browserUrl || "about:blank") : "未启动共享浏览器"}</span>
        {browserController && <i />}
      </div>
      <div className="request-list">
        {traffic.length === 0 && <div className="tf-guide"><div className="tf-guide-title">暂无流量</div><div className="tf-guide-hint">启动共享浏览器后，你和 Agent 的访问都会出现在这里。</div></div>}
        {traffic.map((t) => (
          <article className={`request-row st-${String(t.responseStatus).charAt(0)}`} key={t.id} title={t.url}>
            <div className="request-top">
              <span className={`method ${t.method.toLowerCase()}`}>{t.method}</span>
              <strong>{t.responseStatus}</strong>
            </div>
            <p>{t.url}</p>
          </article>
        ))}
      </div>
    </aside>
  );
}
```
> demo `.request-row` 有 host/size/latency，我们没有 → 省略 `.request-meta`。method 类 get/post/put demo 已有样式。

- [ ] **Step 2: 改 `apps/web/src/components/BrowserPanel.tsx` 导出 BrowserControls（按 demo .browser-button）**

把文件改为只导出一个 `BrowserControls`（控制按钮组，放 Traffic panel-header 右侧），用 demo `.browser-button`：
```tsx
import { Browser } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { startBrowser, stopBrowser, takeoverBrowser, releaseBrowser } from "../api.js";

export function BrowserControls() {
  const { caseId, browserController } = useStore();
  if (!caseId) return null;
  if (browserController === null) {
    return <button className="browser-button" onClick={() => startBrowser(caseId)}><Browser size={15} /> 启动浏览器</button>;
  }
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {browserController === "llm"
        ? <button className="browser-button" onClick={() => takeoverBrowser(caseId)}>接管</button>
        : <button className="browser-button active" onClick={() => releaseBrowser(caseId)}>交回 LLM</button>}
      <button className="browser-button" onClick={() => stopBrowser(caseId)}>停止</button>
    </div>
  );
}
```
> 旧 `BrowserPanel` 不再被 App 直接用（App.tsx Task 2 已去掉左栏拆分）；删除旧 `export function BrowserPanel` 或保留为兼容——本计划删旧 BrowserPanel 默认导出，App 不再 import 它。

- [ ] **Step 3: 删 App.tsx 对 BrowserPanel 的残留 import**

确认 App.tsx 顶部已无 `import { BrowserPanel }`（Task 2 改三栏时应已去）。若残留则删。

- [ ] **Step 4: 加 request-row 状态色（app.css 补）**

app.css 追加（demo 的 .request-row 已有 risk 色，我们用 st-2/3/4/5 映射状态码）：
```css
.request-row.st-2 strong { color: var(--green); }
.request-row.st-3 strong { color: var(--accent); }
.request-row.st-4 strong { color: var(--amber); }
.request-row.st-5 strong { color: var(--red); }
```

- [ ] **Step 5: tsc + build**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 0；build 成功。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): align traffic + browser controls to demo (.traffic-panel/.request-row)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: AgentPanel + Select + CaseLauncher —— 对齐 demo .chat-panel

**Files:**
- Modify: `apps/web/src/components/AgentPanel.tsx`, `apps/web/src/components/Select.tsx`(仅 className 已是 tf-select，Task 1 已浅色化，无需改 TSX), `apps/web/src/components/CaseLauncher.tsx`

**Interfaces:**
- Consumes: demo `.chat-panel`/`.panel-header`/`.objective-block`/`.messages`/`.message`/`.composer`（Task 1）。
- Produces: 中栏 Agent = demo Run Console 风。

- [ ] **Step 1: 改 `apps/web/src/components/AgentPanel.tsx` 用 demo .chat-panel**

把外层 panel + 事件流 + composer 改为 demo 结构（事件用 `.message` 三态，目标输入用 `.composer`）。保留现有 EventItem/审批/scope 逻辑，只换 class：
```tsx
  return (
    <main className="panel chat-panel">
      <div className="panel-header"><div><span className="section-kicker">Agent</span><h2>Run Console</h2></div>
        <div className="session-state"><Sparkle size={14} /> autonomous</div>
      </div>
      <section className="messages">
        {pendingApproval && ( /* 审批卡，class 用 tf-confirm tf-confirm-warn，内容不变 */ )}
        {pendingScope && caseId && ( /* scope 卡，tf-confirm tf-confirm-info，不变 */ )}
        {agentEvents.length === 0 && !pendingScope && (
          <div className="tf-guide"><div className="tf-guide-icon"><Sparkle size={22} weight="duotone" /></div><div className="tf-guide-title">Agent 待命</div><div className="tf-guide-hint">在下方输入一个目标，Agent 会自主探索并把发现记录为 Fact。</div></div>
        )}
        {agentEvents.map((e, i) => (
          <div className={`message ${e.kind === "error" ? "trace" : "agent"}`} key={i}>
            <span>{e.kind}</span><p>{e.text}</p>
          </div>
        ))}
      </section>
      <div className="composer">
        <input value={goal} onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && goal.trim()) { resetAgent(); runAgent(caseId, goal); setGoal(""); } }}
          placeholder="给 agent 一个目标…" />
        <button disabled={!goal.trim()} onClick={() => { if (!goal.trim()) return; resetAgent(); runAgent(caseId, goal); setGoal(""); }}><PaperPlaneTilt size={15} weight="fill" /></button>
      </div>
    </main>
  );
```
> 审批/scope 卡保留之前的 `tf-confirm` 结构与 decide 乐观清除逻辑（Task 1 已把 tf-confirm 浅色化），只是现在在 `.messages` 内。EventItem 那套图标徽章可保留或简化为 demo `.message`——本计划用 demo `.message` 三态（agent/operator/trace），把工具调用也作为 agent message 显示（text 已是 "tool(arg)"）。

- [ ] **Step 2: 改 `apps/web/src/components/CaseLauncher.tsx` 的 hero 卡浅色**

hero 变体外层 `.tf-launcher` 改用浅色（Task 1 的浅色类或内联）：把 className `tf-launcher` 在 app.css 加浅色样式：
```css
.tf-launcher { display: flex; flex-direction: column; gap: 12px; padding: 18px; border: 1px solid var(--line); border-radius: 12px; background: #fff; box-shadow: var(--shadow); margin-top: 16px; }
.tf-launcher-label { font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.tf-launcher-or { display: flex; align-items: center; gap: 10px; color: var(--faint); font-size: 11.5px; }
.tf-launcher-or::before, .tf-launcher-or::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.tf-btn-block { width: 100%; justify-content: center; height: 36px; }
.tf-input-block { width: 100%; }
```
（CaseLauncher TSX 不改，class 已就位。）

- [ ] **Step 3: tsc + build**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 0；build 成功。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): align agent console to demo (.chat-panel/.message/.composer)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: KnowledgePanel + Tab + GraphView 去作用域 —— 整体浅色统一

**Files:**
- Modify: `apps/web/src/components/KnowledgePanel.tsx`, `apps/web/src/components/GraphView.tsx`（去 `.tf-graph` 类）, `apps/web/src/components/knowledge/GraphTab.tsx`/`GraphModal.tsx`

**Interfaces:**
- Consumes: demo `.graph-panel`/`.graph-header`/`.graph-count`/`.graph-canvas`、全局 `.flow-card`（Task 1 移植已全局浅色）。
- Produces: 右栏知识区 demo 风；图谱去作用域整体浅色。

- [ ] **Step 1: 改 `apps/web/src/components/KnowledgePanel.tsx` 用 demo .graph-panel 风**

外层用 `.panel`，header 用 `.panel-header`+`.section-kicker`，tabs 用 `.tf-tabs`（Task 1 浅色），body 用浅色：
```tsx
  return (
    <aside className="panel graph-panel">
      <div className="panel-header"><div><span className="section-kicker">Knowledge</span><h2>{TAB_TITLE[activeTab]}</h2></div></div>
      <div className="tf-tabs">{TABS.map((t) => <button key={t.key} className={`tf-tab ${activeTab === t.key ? "active" : ""}`} onClick={() => setActiveTab(t.key)}>{t.label}</button>)}</div>
      <div className="graph-canvas" style={{ overflow: activeTab === "graph" ? "hidden" : "auto", padding: activeTab === "graph" ? 0 : "10px 14px" }}>
        {activeTab === "facts" && <FactsTab />}
        {activeTab === "tasks" && <TasksTab />}
        {activeTab === "timeline" && <TimelineTab />}
        {activeTab === "mcp" && <McpTab />}
        {activeTab === "graph" && <GraphTab />}
        {activeTab === "observer" && <ObserverTab />}
      </div>
    </aside>
  );
```
加 `const TAB_TITLE: Record<string,string> = { facts:"Facts", tasks:"Tasks", timeline:"Timeline", mcp:"MCP 工具", graph:"证据图谱", observer:"Observer 监督" };`
（`.graph-panel` demo 是 `grid-template-rows: auto minmax(0,1fr)`——Task 1 已去掉 footer 行，这里 tabs + body 两行用 panel 内 flex 即可；若 grid 行数不符，KnowledgePanel 外层不用 `.graph-panel` 而用 `.panel` + 内部 flex 列。简化：外层 `className="panel"` + `style={{display:"flex",flexDirection:"column"}}`。）

- [ ] **Step 2: GraphView 去 `.tf-graph` 作用域**

`apps/web/src/components/GraphView.tsx`：把根容器 `<div className="tf-graph" ...>` 改为 `<div className="tf-graph-wrap" ...>`（仅作定位容器，不再做样式作用域）。因为 Task 1 移植 demo styles.css 后 `.flow-card`/`.edge-label`/`.react-flow` 已是全局浅色，节点样式自动生效。app.css 里第 2 轮带 `.tf-graph` 前缀的样式块已在 Task 1 删除/替换为 demo 全局版。DetailPanel 的 `.tf-gdetail` Task 1 已浅色化。

- [ ] **Step 3: GraphTab / GraphModal 浅色微调**

`GraphTab.tsx`：放大按钮用 `.tf-btn`；容器边框用 `var(--line)`。`GraphModal.tsx`：`.tf-modal-bg`/`.tf-modal`（Task 1 已浅色）；标题栏文字深色。具体：GraphTab 容器 `border: 1px solid var(--line)`；GraphModal header 用 `.panel-header` 风。

- [ ] **Step 4: 各 knowledge Tab 行样式确认（FactsTab/TasksTab/TimelineTab/McpTab/ObserverTab）**

这些 Tab 已用 `.tf-row`/`.tf-tag`/`.tf-guide`（Task 1 已浅色化），无需改 TSX。ObserverTab 的 level 色用 CSS 变量（app.css 加）：
```css
.obs-critical { color: var(--red); } .obs-warning { color: var(--amber); } .obs-info { color: var(--muted); }
```
**内联旧变量替换**（已核查这些文件有内联 `var(--tf-*)`）：ObserverTab.tsx（`--tf-err`→`--red`、`--tf-warn`→`--amber`、`--tf-muted`→`--muted`、`--tf-faint`→`--faint`）、McpTab.tsx（`--tf-*`→对应 demo 变量）、GraphTab.tsx（`--tf-border`→`--line` 等）。逐个改成 demo 变量；Task 6 Step 2 grep 兜底。

- [ ] **Step 5: tsc + build + 全量 build**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm -r build`
Expected: tsc 0；全量构建成功。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): align knowledge panel + graph to demo, unify light theme

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 收尾 —— 全量校验、端到端、文档（3 轮收尾）

**Files:**
- Modify: `README.md`, `TraceForge_design.md`

- [ ] **Step 1: 全量测试 + 构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿（169，前端无新测试）；各包构建无错。

- [ ] **Step 2: 全局 grep 残留深色变量**

Run: `grep -rn "var(--tf-" apps/web/src || echo "无残留 tf 变量"`
Expected: 无残留 `--tf-*`（旧深色变量已废）；若有，改为 demo 变量（--accent/--muted/--line/--red/--amber/--green）。

- [ ] **Step 3: 端到端手动验证**

```bash
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('live.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 5
# 另起 pnpm --filter @traceforge/web dev → http://localhost:5173
# 1) 首屏浅色 demo 风；2) 建 case → 三栏（流量/Run Console/Knowledge）全浅色 demo 风
# 3) 启浏览器、agent run、审批卡、图谱白卡片、各 Tab — 整体浅色统一、对齐 demo
# 清理：杀后端、删 server.log
```
Expected: 整个工作台浅色专业风，对齐 demo；功能（Case/浏览器/agent/审批/图谱/Tab）正常。

- [ ] **Step 4: 更新 `README.md`**

把图谱第 2 轮行后追加：
```markdown
- 整体 demo 风样式（图谱重做 第 3 轮 / 共 3 轮 · 收尾）：以 BreachWeave demo 的 styles.css 为基底重做整个工作台为浅色专业风（.app-shell/.topbar/.workspace/.panel/.request-row/.message/.composer），各组件结构对齐 demo；演示专用部分（重放/假导航/写死 id）换成真功能（Case 选择/控制权状态/真事件流）；去图谱作用域整体浅色统一。保留 Geist+思源黑字体
```

- [ ] **Step 5: 设计文档第 31 章注记图谱重做完成**

在 `TraceForge_design.md` 第 31.3 节第 3 项「Graph Panel」那条的 ✅ 后补：「+ 工作流图谱 3 轮重做完成（实时数据机制 + @xyflow/elk 引擎 + 整体 demo 浅色风）」。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: update README and roadmap for demo-style UI (graph rework round 3 done)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：§2 app.css 移植 → Task 1；§3 组件对齐表 → Task 2（App/TopBar）+ Task 3（Traffic/Browser）+ Task 4（Agent/Select/CaseLauncher）+ Task 5（Knowledge/Tab/Graph）；§1 演示专用换真功能 → Task 2（run id→控制权、导航→Case）+ Task 3（无重放）；§1 去 .tf-graph 作用域 → Task 5；§4 数据/功能不变 → 全任务只改 class/JSX；§5 缺字段省略 → Task 3（流量无 size/latency）；§6 测试 → Task 6；§7 理念 → 照 demo/真功能/整体统一贯穿；§8 分解 = 本 6 任务。
- **类型一致性**：demo class 名全程一致（.app-shell/.topbar/.workspace/.panel/.traffic-panel/.request-row/.chat-panel/.message/.composer/.graph-panel/.flow-card）；我们特有类 tf-select*/tf-confirm*/tf-stat*/tf-guide*/tf-btn*/tf-tab*/tf-row/tf-tag/tf-gdetail*（Task 1 定义，各组件用）；BrowserControls（Task 3 新导出，TrafficPanel 用）；CaseLauncher variant bar/hero（既有，TopBar/App 用）。
- **风险**：BrowserPanel 重构为 BrowserControls——App.tsx 不再 import BrowserPanel（Task 2 三栏已去左栏拆分，Task 3 删旧导出）；执行时确保无悬空 import（tsc 会报）。
- **已知简化**：事件流用 demo `.message` 三态替代第 2 轮的 EventItem 图标徽章（更贴 demo）；流量行省 host/size/latency（我们无）；重放控件不做。
- **前端无单测**：全靠 tsc + build + 端到端手测（Task 6）；后端零改动，pnpm test 仍 169 全绿。
