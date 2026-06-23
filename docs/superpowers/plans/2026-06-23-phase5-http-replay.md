# TraceForge 阶段 5：通用 HTTP 重放引擎 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本计划在当前会话由控制者直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供一个**通用**的 HTTP 重放引擎：能重发任意请求（改 URL / 参数 / header / body 任意部分），并对比响应差异。它**不内置任何针对特定漏洞类型的探测逻辑**——SQLi / XSS / SSRF / 越权 / 路径遍历等各类漏洞的测试变体，由后续子阶段的 AI 生成（AI 决定改哪个部分、换成什么值、看什么响应特征），本引擎只负责"忠实重发 + 客观对比"。这是系统**第一个真正对外发网络请求**的功能，所有重放目标必须经 Scope Guard 校验（越界 403）。重放是低风险动作，范围内可直接发，无需逐次人工确认（对齐 3.4）。

**Architecture:** 新增 `@traceforge/tools` 包，内含 `http-replay`：`replay(request)` 用 Node 原生 `fetch` 发请求并返回归一化响应（status / 响应体长度 / body 文本 / 关键 header）；`modifyParam(request, param, value)` 通用地改 URL query 参数（保留其它参数），不绑定任何 payload；`compareResponses(a, b)` 做**客观**对比（状态码是否变化、长度差、是否含数据库错误特征——仅作为客观信号，不替 AI 下"是某漏洞"的结论）。server 新增重放路由（所有目标经 Scope Guard）：`POST /api/cases/:id/replay`（单次重放任意请求）、`POST /api/cases/:id/replay-compare`（发两个请求并返回对比，供"原始 vs 改动后"使用）。前端新增 Replay 面板：从 traffic 行选一条载入，手动改 URL/参数/方法重放看响应，或填两个请求做对比。

> **范围边界（按用户决定）：** 本阶段只做扎实的通用重放 + 对比引擎，不做任何漏洞专用探测器（不写 SqliProber/XssProber 等）。"针对某漏洞类型自动生成测试变体并解读"是**下一个子阶段**的事，由 AI（扩展 ActionPlanner）完成——新漏洞类型无需改代码。

**Tech Stack:** 沿用前序。HTTP 用 Node 原生 `fetch`（Node ≥ 22 内置，无新依赖）。

## Global Constraints

- 沿用阶段 0-4 全部约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest、`@traceforge/shared` 单源类型、所有业务表带 `case_id`、纯逻辑模块必须单测。
- **通用、不内置漏洞探测器（核心约束）：** `@traceforge/tools` 中**不得出现任何特定漏洞的 payload 或探测逻辑**（不写死 `'`/`"`/`<script>`/`../` 等）。引擎只提供"重发任意请求 + 改任意参数为任意值 + 客观对比"。漏洞类型相关的测试值由调用方（未来的 AI）传入。
- **Scope Guard 是对外动作的硬门（设计文档 26.5）：** 任何重放的目标 host 在发请求前必须经 `checkScope` 校验；越界返回 403 并发 `scope_violation` 事件，绝不发出请求。
- **原始信号，不替 AI 下结论：** `compareResponses` 只返回 statusChanged / lengthDelta 两个原始信号，**不内置任何错误特征关键词库**。两个完整响应 body 原样返回，"是否像报错/像注入/像越权"由 AI 读 body 自行判断——引擎保持漏洞无关。
- **纯逻辑可单测：** `compareResponses`/`modifyParam` 是纯函数；`replay` 的网络发送经注入的 `Fetcher` 完成，单测用 mock，禁止测试中真实联网。
- **重放低风险、范围内直接发：** 不为每次重放生成 Action Card 等人工确认（对齐 3.4「低风险动作」）；Scope Guard 是唯一强制门。
- 重放结果落 timeline（事件类型 `replay`）并 emit 事件，保持「Timeline 即历史」。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: tools 包 —— 通用 http-replay（replay + modifyParam + compareResponses）

**Files:**
- Create: `packages/tools/package.json`
- Create: `packages/tools/tsconfig.json`
- Create: `packages/tools/src/http-replay.ts`
- Create: `packages/tools/src/index.ts`
- Test: `packages/tools/src/http-replay.test.ts`

**Interfaces:**
- Consumes: 无内部依赖。
- Produces：
  - `interface ReplayRequest { url: string; method: string; headers?: Record<string,string>; body?: string }`
  - `interface ReplayResponse { status: number; bodyLength: number; body: string; headers: Record<string,string> }`
  - `type Fetcher = (req: ReplayRequest) => Promise<ReplayResponse>`
  - `replay(req, fetcher?): Promise<ReplayResponse>` —— 默认 fetcher 用 Node `fetch`；可注入 mock。
  - `modifyParam(req, param, value): ReplayRequest` —— 通用：把 URL query 中 `param` 设为 `value`（保留其它参数）；参数不存在则原样返回。**不附加任何 payload，value 完全由调用方给定。**
  - `interface CompareResult { statusChanged: boolean; lengthDelta: number }` —— **纯原始信号，无 verdict、无关键词库、不下任何漏洞结论**。是否"像报错""像注入"由上层 LLM 读 body 判断，引擎不内置任何漏洞视角的关键词。
  - `compareResponses(base, variant): CompareResult` —— 只返回状态码是否变化、响应体长度差。两个完整 body 已在 base/variant 响应对象里，LLM 自行解读。

- [ ] **Step 1: 写 `packages/tools/package.json`**

```json
{
  "name": "@traceforge/tools",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc -p tsconfig.json" }
}
```

- [ ] **Step 2: 写 `packages/tools/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "lib": ["ES2023", "DOM"] },
  "include": ["src"]
}
```

> 注：`lib` 含 DOM 是为了 Node 原生 `fetch`/`Response` 的类型；不引入浏览器运行时。

- [ ] **Step 3: 写失败测试 `packages/tools/src/http-replay.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { replay, modifyParam, compareResponses, type ReplayResponse } from "./http-replay.js";

const baseResp: ReplayResponse = { status: 200, bodyLength: 100, body: "ok ".repeat(33) + "x", headers: {} };

describe("replay", () => {
  it("uses the injected fetcher", async () => {
    const out = await replay(
      { url: "https://t.com/api", method: "GET" },
      async () => ({ status: 201, bodyLength: 3, body: "abc", headers: { "x-test": "1" } }),
    );
    expect(out.status).toBe(201);
    expect(out.headers["x-test"]).toBe("1");
  });
});

describe("modifyParam", () => {
  it("sets a query param to an arbitrary value, preserving others", () => {
    const out = modifyParam({ url: "https://t.com/a?id=1&page=2", method: "GET" }, "id", "anything-AI-wants");
    expect(out.url).toContain("page=2");
    expect(out.url).toContain("id=anything-AI-wants");
  });

  it("returns the request unchanged when the param is absent", () => {
    const req = { url: "https://t.com/a?page=2", method: "GET" };
    expect(modifyParam(req, "id", "x").url).toBe(req.url);
  });
});

describe("compareResponses", () => {
  it("reports a status code change", () => {
    expect(compareResponses(baseResp, { ...baseResp, status: 500 }).statusChanged).toBe(true);
  });

  it("reports the length delta", () => {
    const variant = { ...baseResp, bodyLength: 180, body: baseResp.body + "y".repeat(80) };
    expect(compareResponses(baseResp, variant).lengthDelta).toBe(80);
  });

  it("returns zero deltas for identical responses (no vuln-specific judgement)", () => {
    const r = compareResponses(baseResp, { ...baseResp });
    expect(r.statusChanged).toBe(false);
    expect(r.lengthDelta).toBe(0);
  });

  it("only exposes raw signals — no errorSignature/verdict keys (LLM reads body itself)", () => {
    const r = compareResponses(baseResp, { ...baseResp, body: "You have an error in your SQL syntax" });
    expect(Object.keys(r).sort()).toEqual(["lengthDelta", "statusChanged"]);
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm install && pnpm vitest run packages/tools`
Expected: FAIL —— 模块不存在。

- [ ] **Step 5: 写 `packages/tools/src/http-replay.ts`**

```ts
export interface ReplayRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ReplayResponse {
  status: number;
  bodyLength: number;
  body: string;
  headers: Record<string, string>;
}

export type Fetcher = (req: ReplayRequest) => Promise<ReplayResponse>;

const defaultFetcher: Fetcher = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, bodyLength: body.length, body, headers };
};

export async function replay(req: ReplayRequest, fetcher: Fetcher = defaultFetcher): Promise<ReplayResponse> {
  return fetcher(req);
}

// 通用参数改写：把 query 中 param 设为任意 value，保留其它参数。不附加任何 payload。
export function modifyParam(req: ReplayRequest, param: string, value: string): ReplayRequest {
  const u = new URL(req.url);
  if (!u.searchParams.has(param)) return req;
  u.searchParams.set(param, value);
  return { ...req, url: u.toString() };
}

export interface CompareResult {
  statusChanged: boolean;
  lengthDelta: number;
}

// 只返回原始信号。不内置任何漏洞视角的关键词库——"像报错/像注入/像越权"等判断
// 由上层 LLM 直接读 base/variant 的完整 body 自行得出，引擎保持漏洞无关。
export function compareResponses(base: ReplayResponse, variant: ReplayResponse): CompareResult {
  return {
    statusChanged: base.status !== variant.status,
    lengthDelta: variant.bodyLength - base.bodyLength,
  };
}
```

- [ ] **Step 6: 写 `packages/tools/src/index.ts`**

```ts
export {
  replay, modifyParam, compareResponses,
  type ReplayRequest, type ReplayResponse, type Fetcher, type CompareResult,
} from "./http-replay.js";
```

- [ ] **Step 7: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/tools && pnpm --filter @traceforge/tools exec tsc --noEmit -p tsconfig.json`
Expected: 7 用例全绿（replay 1 + modifyParam 2 + compareResponses 4）；tsc 退出码 0。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(tools): add generic http-replay engine (replay/modifyParam/compareResponses)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: server —— 重放与对比路由（Scope Guard 守护）

**Files:**
- Modify: `apps/server/package.json`（加 `@traceforge/tools` 依赖）
- Modify: `apps/server/src/routes.ts`
- Test: `apps/server/src/routes-phase5.test.ts`

**Interfaces:**
- Consumes: `replay`/`compareResponses`/`Fetcher`（tools）、`checkScope`（tool-resolver）、现有 `CaseStore`/`TimelineStore`/`EventBus`、`registerRoutes`。
- Produces：
  - `registerRoutes` 签名增加可选第 5 参 `fetcher?: Fetcher`（默认用 tools 的真实 fetcher；测试注入 mock）。
  - 内部 helper `guardScope(caseId, url, reply): boolean`——取 case、checkScope，越界 emit + 403 返回 false，否则 true（DRY，replay/compare 共用）。
  - `POST /api/cases/:id/replay`：body `{ url, method, headers?, body? }`。Scope Guard → `replay(req, fetcher)` → timeline(`replay`) → emit `timeline_appended` → 返回 ReplayResponse。404 当 case 不存在。
  - `POST /api/cases/:id/replay-compare`：body `{ base: ReplayRequest, variant: ReplayRequest }`。**两个请求的 url 都过 Scope Guard** → 各 `replay` 一次 → `compareResponses(baseResp, variantResp)` → timeline(`replay-compare`) → emit → 返回 `{ base: ReplayResponse, variant: ReplayResponse, compare: CompareResult }`。

- [ ] **Step 1: 给 `apps/server/package.json` dependencies 加** `"@traceforge/tools": "workspace:*"`，然后 `pnpm install`。

- [ ] **Step 2: 写失败测试 `apps/server/src/routes-phase5.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import type { Fetcher, ReplayRequest } from "@traceforge/tools";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;

// mock fetcher：URL 含 'broken' 回 500+SQL 错误，否则回基线
const fetcher: Fetcher = async (req: ReplayRequest) =>
  req.url.includes("broken")
    ? { status: 500, bodyLength: 36, body: "You have an error in your SQL syntax", headers: {} }
    : { status: 200, bodyLength: 100, body: "x".repeat(100), headers: {} };

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  registerRoutes(app, db, bus, undefined, fetcher);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
  events.length = 0;
});

describe("replay route", () => {
  it("replays an in-scope request", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/replay`, payload: { url: "https://t.com/api", method: "GET" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(200);
  });

  it("rejects an out-of-scope replay with 403 and emits scope_violation", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/replay`, payload: { url: "https://evil.com/api", method: "GET" } });
    expect(res.statusCode).toBe(403);
    expect(events.some((e) => e.type === "scope_violation")).toBe(true);
  });
});

describe("replay-compare route", () => {
  it("returns objective compare signals for two in-scope requests", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/cases/${caseId}/replay-compare`,
      payload: {
        base: { url: "https://t.com/api/order?id=1", method: "GET" },
        variant: { url: "https://t.com/api/order?id=broken", method: "GET" },
      },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.compare.statusChanged).toBe(true);
    // 引擎不下漏洞结论；variant 的完整 body 原样返回，供 LLM 自行解读
    expect(out.variant.body).toContain("SQL syntax");
  });

  it("rejects when either request is out of scope", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/cases/${caseId}/replay-compare`,
      payload: {
        base: { url: "https://t.com/ok", method: "GET" },
        variant: { url: "https://evil.com/x", method: "GET" },
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run apps/server/src/routes-phase5.test.ts`
Expected: FAIL —— 路由不存在 / registerRoutes 不接受第 5 参。

- [ ] **Step 4: 修改 `apps/server/src/routes.ts`**

顶部 import 增加：

```ts
import { replay, compareResponses, type Fetcher } from "@traceforge/tools";
```

签名改为（加第 5 参 `fetcher?`）：

```ts
export function registerRoutes(
  app: FastifyInstance,
  db: Db,
  bus: EventBus,
  provider?: LlmProvider,
  fetcher?: Fetcher,
): void {
```

在末尾路由区追加（`registerRoutes` 闭合 `}` 之前）：

```ts
  // 共用：取 case + Scope Guard；越界 emit + 403 返回 null
  function guardCaseScope(caseId: string, url: string, reply: import("fastify").FastifyReply): boolean {
    const c = cases.get(caseId);
    if (!c) { reply.code(404).send({ error: "case not found" }); return false; }
    const verdict = checkScope(url, c.scopeRules);
    if (!verdict.allowed) {
      bus.emit({ type: "scope_violation", caseId, url, reason: verdict.reason });
      reply.code(403).send({ error: "out of scope", reason: verdict.reason });
      return false;
    }
    return true;
  }

  app.post("/api/cases/:id/replay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { url: string; method: string; headers?: Record<string, string>; body?: string };
    if (!guardCaseScope(id, body.url, reply)) return reply;
    const response = await replay({ url: body.url, method: body.method, headers: body.headers, body: body.body }, fetcher);
    const entry = timelineStore.append(id, "replay", `Replay ${body.method} ${body.url} → ${response.status}`);
    bus.emit({ type: "timeline_appended", entry });
    return response;
  });

  app.post("/api/cases/:id/replay-compare", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      base: { url: string; method: string; headers?: Record<string, string>; body?: string };
      variant: { url: string; method: string; headers?: Record<string, string>; body?: string };
    };
    if (!guardCaseScope(id, body.base.url, reply)) return reply;
    if (!guardCaseScope(id, body.variant.url, reply)) return reply;
    const baseResp = await replay(body.base, fetcher);
    const variantResp = await replay(body.variant, fetcher);
    const compare = compareResponses(baseResp, variantResp);
    const entry = timelineStore.append(id, "replay-compare", `Compare ${body.variant.url}: status±${compare.statusChanged} len${compare.lengthDelta}`);
    bus.emit({ type: "timeline_appended", entry });
    return { base: baseResp, variant: variantResp, compare };
  });
```

> 注：`checkScope` 已在阶段 1 import；`cases`/`timelineStore` 已在函数体内初始化。`guardCaseScope` 返回 false 时已 `reply.code(...).send(...)`，路由 `return reply` 结束。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run apps/server/src/routes-phase5.test.ts`
Expected: PASS（replay 范围内 200 / 越界 403+事件、compare 客观信号 / 任一越界 403）。

- [ ] **Step 6: tsc + 全量 server 测试**

Run: `pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json && pnpm vitest run apps/server`
Expected: tsc 退出码 0；server 全部测试（阶段 1-5）通过。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(server): add scope-guarded replay and replay-compare routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: web —— Replay 面板（重放 + 对比）

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: 阶段 5 路由、`ReplayResponse`/`CompareResult`（`@traceforge/tools`）、现有 web store/api。
- Produces：
  - `api.ts`：`replayRequest(caseId, req) → ReplayResponse`、`replayCompare(caseId, base, variant) → { base, variant, compare }`。
  - `App.tsx`：在 Traffic 区块下方新增 Replay 区块——URL + method + 「重放」按钮（显示返回 status / 长度）；以及「对比」区：base url、variant url、「对比」按钮（显示 statusChanged / lengthDelta 原始信号 + 两个响应的 body 片段）。结果用本地 React state。**前端不做漏洞判定**，只展示原始信号与 body，留给未来 AI 解读。

- [ ] **Step 1: 扩展 `apps/web/src/api.ts`**

```ts
import type { ReplayResponse, CompareResult } from "@traceforge/tools";

type Req = { url: string; method: string; headers?: Record<string, string>; body?: string };

export async function replayRequest(caseId: string, req: Req): Promise<ReplayResponse> {
  return (await fetch(`/api/cases/${caseId}/replay`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req),
  })).json();
}

export async function replayCompare(
  caseId: string, base: Req, variant: Req,
): Promise<{ base: ReplayResponse; variant: ReplayResponse; compare: CompareResult }> {
  return (await fetch(`/api/cases/${caseId}/replay-compare`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ base, variant }),
  })).json();
}
```

- [ ] **Step 2: 扩展 `apps/web/src/App.tsx`**

import 加 `replayRequest, replayCompare`，组件内加本地 state：

```tsx
  const [replayUrl, setReplayUrl] = useState("https://example.com/");
  const [replayMethod, setReplayMethod] = useState("GET");
  const [replayResult, setReplayResult] = useState("");
  const [cmpBase, setCmpBase] = useState("https://example.com/?id=1");
  const [cmpVariant, setCmpVariant] = useState("https://example.com/?id=2");
  const [cmpResult, setCmpResult] = useState("");
```

在 Traffic 区块之后插入：

```tsx
      <h2>Replay</h2>
      <input value={replayUrl} onChange={(e) => setReplayUrl(e.target.value)} style={{ width: 360 }} />
      <input value={replayMethod} onChange={(e) => setReplayMethod(e.target.value)} style={{ width: 60 }} />
      <button onClick={async () => {
        const r = await replayRequest(caseId, { url: replayUrl, method: replayMethod });
        setReplayResult(`status=${r.status} len=${r.bodyLength}`);
      }}>重放</button>
      <span> {replayResult}</span>

      <h3>对比（原始 vs 改动后）</h3>
      <input value={cmpBase} onChange={(e) => setCmpBase(e.target.value)} style={{ width: 320 }} />
      <input value={cmpVariant} onChange={(e) => setCmpVariant(e.target.value)} style={{ width: 320 }} />
      <button onClick={async () => {
        const r = await replayCompare(caseId, { url: cmpBase, method: "GET" }, { url: cmpVariant, method: "GET" });
        setCmpResult(`statusChanged=${r.compare.statusChanged} lenΔ=${r.compare.lengthDelta} | variant body: ${r.variant.body.slice(0, 120)}`);
      }}>对比</button>
      <span> {cmpResult}</span>
```

- [ ] **Step 3: tsc + 构建**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 退出码 0；Vite 构建成功。

- [ ] **Step 4: 端到端验证（真实 fetch 打公网，验证 Scope Guard + 重放成功）**

Run（确认 4000 空闲；真实 fetcher 打 example.com）：

```bash
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('e2e.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 5
CID=$(curl -s -X POST localhost:4000/api/cases -H 'content-type: application/json' -d '{"name":"p5","allowHosts":["example.com"]}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "in-scope replay: $(curl -s -X POST localhost:4000/api/cases/$CID/replay -H 'content-type: application/json' -d '{"url":"https://example.com/","method":"GET"}' | grep -o '"status":[0-9]*')"
echo "out-of-scope code: $(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:4000/api/cases/$CID/replay -H 'content-type: application/json' -d '{"url":"https://evil.com/","method":"GET"}')"
# 清理后端进程与 e2e.sqlite*
```
Expected: in-scope replay 返回含 `"status":200`（example.com 实际响应）；out-of-scope code 403。compare 客观信号逻辑已由 Task 1/2 的 mock 测试覆盖。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): add Replay panel with request replay and objective compare

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 阶段收尾 —— 全量校验与 README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: PASS —— 阶段 1-4（65）+ 阶段 5（tools 7、server routes-phase5 4）全绿。

- [ ] **Step 2: 全量构建**

Run: `pnpm -r build`
Expected: 各包无错误（新增 `@traceforge/tools`）。

- [ ] **Step 3: 更新 `README.md`**

"当前进度"标题改为"阶段 0 + 1 + 2 + 3 + 4 + 5"，追加：

```markdown
- 通用 HTTP 重放引擎：重发任意请求（改 URL/参数/header/body 任意部分）+ 原始响应对比（状态码/长度，body 原样返回），所有对外请求受 Scope Guard 守护（越界 403）。引擎不内置漏洞专用探测器、不内置错误关键词库——各类漏洞（SQLi/XSS/SSRF/越权…）的测试变体生成与响应解读由后续 AI 阶段完成
```

把测试数量更新为实际值。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README for phase 5 (generic http replay engine)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：对应设计文档第 21 章「阶段 5：HTTP Replay」与 11.3 工具接口（replay / modifyParam / compareResponses）。**关键修订**：按用户决定，本阶段只做**通用**重放引擎，不内置任何漏洞专用探测器（删去了原计划的 SQLi 专用 ProgressiveProber）；"针对任意漏洞类型生成测试变体并解读"由后续子阶段的 AI 完成（扩展 ActionPlanner），新漏洞类型无需改代码。
- **通用性约束落点**：`@traceforge/tools` 不含任何 payload、也不含任何错误关键词库（无 `'`/`"`/`<script>`/`SQL syntax` 等写死值）——`modifyParam` 的 value 完全由调用方给定，`compareResponses` 只返回 statusChanged/lengthDelta 原始信号、body 原样返回供 LLM 解读。Task 1 的 modifyParam 测试用 `"anything-AI-wants"` 作 value、compareResponses 测试断言只有 `lengthDelta`/`statusChanged` 两个 key，双重强调引擎漏洞无关。
- **类型一致性**：`ReplayRequest`/`ReplayResponse`/`Fetcher`/`CompareResult` 单源于 `@traceforge/tools`（Task 1），server（Task 2）与 web（Task 3）消费同一份。`registerRoutes` 第 5 参 `fetcher?` 在 Task 2 定义，测试注入 mock、生产用默认真实 fetcher。
- **安全约束落点**：Scope Guard 守门——replay 与 replay-compare（两个 url 都校验）发请求前都 `checkScope`，越界 403 + emit scope_violation，由 Task 2 的两个 403 测试守住；纯逻辑（modifyParam/compareResponses）不联网，replay 经注入 Fetcher，单测全 mock。
- **重放不走人工确认**：按用户决定，重放低风险，范围内直接发，Scope Guard 是唯一强制门（对齐 3.4）。
- **已知简化**：response body 全量返回，长 body 截断属第 25 章上下文管理，后续处理；真实 fetch 无超时/重试，生产化时加 AbortController；`modifyParam` 仅改 query 参数，body/header 参数改写留待需要时补（AI 生成变体时也可直接给完整 ReplayRequest，不依赖 modifyParam）。
