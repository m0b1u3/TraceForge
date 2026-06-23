# TraceForge 阶段 5：HTTP Replay 与递进式验证 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本计划在当前会话由控制者直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供内置 HTTP 重放能力（改参数重发请求 + 响应对比），并把它编排成递进式验证（基线 → 单/双引号最小扰动 → 对比，给出 suspicious/no-diff 判定，对齐设计文档 7.2）。这是系统**第一个真正对外发网络请求**的功能，所有重放目标必须经 Scope Guard 校验（越界 403）。重放是低风险动作，范围内可直接发，无需逐次人工确认（对齐 3.4）。

**Architecture:** 新增 `@traceforge/tools` 包，内含 `http-replay`：`replay(request)` 用 Node 原生 `fetch` 发请求并返回归一化响应（status / 响应体长度 / body 文本 / 关键 header），`compareResponses(a, b)` 做纯逻辑对比（状态码差异、长度差异、错误特征关键词）。`@traceforge/reasoning-core` 新增 `ProgressiveProber`：纯编排逻辑——给定一个带参数的 URL 和一个"发请求"函数，依次发基线 + `'` + `"` 变体，调 compareResponses 给出判定。server 新增重放路由：所有目标经 Scope Guard；`POST /api/cases/:id/replay`（单次重放）、`POST /api/cases/:id/probe`（对某参数做递进式 SQLi 最小扰动探测，返回基线/变体响应摘要 + 判定）。前端新增 Replay 面板：从 traffic 行选一条，改参数重放看对比；或对某参数一键递进探测。

**Tech Stack:** 沿用前序。HTTP 用 Node 原生 `fetch`（Node ≥ 22 内置，无新依赖）。

## Global Constraints

- 沿用阶段 0-4 全部约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest、`@traceforge/shared` 单源类型、所有业务表带 `case_id`、纯逻辑模块必须单测。
- **Scope Guard 是对外动作的硬门（设计文档 26.5）：** 任何重放/探测的目标 host 在发请求前必须经 `checkScope` 校验；越界返回 403 并发 `scope_violation` 事件，绝不发出请求。
- **递进式验证（设计文档 3.2/7.2）：** 探测按 基线 → 最小扰动（单引号、双引号）→ 对比 的顺序，**不一次性发送大量 payload**。本阶段最小扰动集固定为 `'` 与 `"` 两个，不做字典/批量。
- **纯逻辑可单测：** `compareResponses` 与 `ProgressiveProber` 不直接发网络请求——发请求通过注入的函数完成，单测用 mock 发送函数，禁止测试中真实联网。
- **重放低风险、范围内直接发：** 不为每次重放生成 Action Card 等人工确认（对齐 3.4「低风险动作」）；Scope Guard 是唯一强制门。
- 重放/探测结果落 timeline（事件类型 `replay` / `probe`）并 emit 事件，保持「Timeline 即历史」。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: tools 包 —— http-replay（replay + compareResponses）

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
  - `interface CompareResult { statusChanged: boolean; lengthDelta: number; errorSignature: string | null; verdict: "no_diff" | "suspicious" }`
  - `compareResponses(base, variant): CompareResult` —— 纯逻辑：状态码不同 → suspicious；长度差异显著（>某阈值，如基线长度的 5% 或绝对 50 字节）→ suspicious；variant body 含数据库错误特征关键词（如 "SQL syntax"、"ORA-"、"SQLSTATE"、"mysql_"、"PostgreSQL"、"sqlite3"）→ suspicious 且 errorSignature 记关键词；否则 no_diff。

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
import { replay, compareResponses, type ReplayResponse } from "./http-replay.js";

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

describe("compareResponses", () => {
  it("flags status code change as suspicious", () => {
    const variant = { ...baseResp, status: 500 };
    expect(compareResponses(baseResp, variant).verdict).toBe("suspicious");
    expect(compareResponses(baseResp, variant).statusChanged).toBe(true);
  });

  it("flags a large length delta as suspicious", () => {
    const variant = { ...baseResp, bodyLength: 100 + 80, body: baseResp.body + "y".repeat(80) };
    const r = compareResponses(baseResp, variant);
    expect(r.verdict).toBe("suspicious");
    expect(r.lengthDelta).toBe(80);
  });

  it("flags a database error signature as suspicious", () => {
    const variant = { ...baseResp, body: "You have an error in your SQL syntax near ..." };
    const r = compareResponses(baseResp, variant);
    expect(r.verdict).toBe("suspicious");
    expect(r.errorSignature).toMatch(/SQL syntax/);
  });

  it("returns no_diff when responses are effectively identical", () => {
    const variant = { ...baseResp };
    expect(compareResponses(baseResp, variant).verdict).toBe("no_diff");
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

const DB_ERROR_PATTERNS = [
  "SQL syntax", "ORA-", "SQLSTATE", "mysql_", "PostgreSQL", "sqlite3",
  "Unclosed quotation", "ODBC", "Microsoft OLE DB",
];

const LENGTH_DELTA_ABS = 50;
const LENGTH_DELTA_RATIO = 0.05;

export interface CompareResult {
  statusChanged: boolean;
  lengthDelta: number;
  errorSignature: string | null;
  verdict: "no_diff" | "suspicious";
}

export function compareResponses(base: ReplayResponse, variant: ReplayResponse): CompareResult {
  const statusChanged = base.status !== variant.status;
  const lengthDelta = variant.bodyLength - base.bodyLength;
  const sig = DB_ERROR_PATTERNS.find((p) => variant.body.includes(p)) ?? null;

  const significantLength =
    Math.abs(lengthDelta) >= LENGTH_DELTA_ABS &&
    Math.abs(lengthDelta) >= base.bodyLength * LENGTH_DELTA_RATIO;

  const verdict = statusChanged || significantLength || sig !== null ? "suspicious" : "no_diff";
  return { statusChanged, lengthDelta, errorSignature: sig, verdict };
}
```

- [ ] **Step 6: 写 `packages/tools/src/index.ts`**

```ts
export {
  replay, compareResponses,
  type ReplayRequest, type ReplayResponse, type Fetcher, type CompareResult,
} from "./http-replay.js";
```

- [ ] **Step 7: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/tools && pnpm --filter @traceforge/tools exec tsc --noEmit -p tsconfig.json`
Expected: 5 用例全绿；tsc 退出码 0。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(tools): add http-replay with response comparison logic

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: reasoning-core —— ProgressiveProber（递进式最小扰动）

**Files:**
- Create: `packages/reasoning-core/src/progressive-prober.ts`
- Modify: `packages/reasoning-core/src/index.ts`
- Modify: `packages/reasoning-core/package.json`（加 `@traceforge/tools` 依赖）
- Test: `packages/reasoning-core/src/progressive-prober.test.ts`

**Interfaces:**
- Consumes: `replay`/`compareResponses`/`ReplayRequest`/`ReplayResponse`/`Fetcher`（`@traceforge/tools`）。
- Produces：
  - `interface ProbeStep { label: string; request: ReplayRequest; response: ReplayResponse; compareToBase?: import("@traceforge/tools").CompareResult }`
  - `interface ProbeResult { param: string; baseline: ReplayResponse; steps: ProbeStep[]; verdict: "no_diff" | "suspicious" }`
  - `class ProgressiveProber`：构造传入 `Fetcher`（可注入 mock）。
  - `probe(req: ReplayRequest, param: string): Promise<ProbeResult>`：
    1. 发基线请求（原 req）。
    2. 对 url 的 query 中 `param` 依次追加 `'`、`"`（最小扰动），各发一次。
    3. 每个变体 compareResponses 与基线对比。
    4. 任一变体 suspicious → 整体 verdict=suspicious，否则 no_diff。
    5. 不发送其它 payload（递进式硬规则）。
  - 辅助：内部函数对 url 的指定 query 参数追加后缀（保留其它参数）。

- [ ] **Step 1: 给 `packages/reasoning-core/package.json` dependencies 加** `"@traceforge/tools": "workspace:*"`，然后 `pnpm install`。

- [ ] **Step 2: 写失败测试 `packages/reasoning-core/src/progressive-prober.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import type { ReplayRequest, ReplayResponse, Fetcher } from "@traceforge/tools";
import { ProgressiveProber } from "./progressive-prober.js";

const base: ReplayResponse = { status: 200, bodyLength: 100, body: "x".repeat(100), headers: {} };

describe("ProgressiveProber", () => {
  it("sends baseline + single-quote + double-quote variants only", async () => {
    const seen: string[] = [];
    const fetcher: Fetcher = async (req: ReplayRequest) => { seen.push(req.url); return base; };
    const out = await new ProgressiveProber(fetcher).probe(
      { url: "https://t.com/api/order?id=1001", method: "GET" }, "id",
    );
    expect(seen).toHaveLength(3); // baseline + ' + "
    expect(seen[0]).toContain("id=1001");
    expect(seen[1]).toContain("id=1001'");
    expect(seen[2]).toContain('id=1001"');
    expect(out.verdict).toBe("no_diff");
  });

  it("marks suspicious when a variant triggers a db error", async () => {
    const fetcher: Fetcher = async (req: ReplayRequest) =>
      req.url.includes("'")
        ? { status: 500, bodyLength: 40, body: "You have an error in your SQL syntax", headers: {} }
        : base;
    const out = await new ProgressiveProber(fetcher).probe(
      { url: "https://t.com/api/order?id=1001", method: "GET" }, "id",
    );
    expect(out.verdict).toBe("suspicious");
    expect(out.steps.some((s) => s.compareToBase?.verdict === "suspicious")).toBe(true);
  });

  it("preserves other query params when perturbing one", async () => {
    const seen: string[] = [];
    const fetcher: Fetcher = async (req: ReplayRequest) => { seen.push(req.url); return base; };
    await new ProgressiveProber(fetcher).probe(
      { url: "https://t.com/a?id=1&page=2", method: "GET" }, "id",
    );
    expect(seen[1]).toContain("page=2");
    expect(seen[1]).toContain("id=1'");
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run packages/reasoning-core/src/progressive-prober.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 写 `packages/reasoning-core/src/progressive-prober.ts`**

```ts
import {
  replay, compareResponses,
  type ReplayRequest, type ReplayResponse, type Fetcher, type CompareResult,
} from "@traceforge/tools";

export interface ProbeStep {
  label: string;
  request: ReplayRequest;
  response: ReplayResponse;
  compareToBase?: CompareResult;
}

export interface ProbeResult {
  param: string;
  baseline: ReplayResponse;
  steps: ProbeStep[];
  verdict: "no_diff" | "suspicious";
}

// 最小扰动集：仅单引号与双引号（递进式硬规则，不做批量 payload）
const PERTURBATIONS = ["'", '"'];

function perturbParam(url: string, param: string, suffix: string): string {
  const u = new URL(url);
  const current = u.searchParams.get(param);
  if (current === null) return url;
  u.searchParams.set(param, current + suffix);
  return u.toString();
}

export class ProgressiveProber {
  constructor(private fetcher: Fetcher) {}

  async probe(req: ReplayRequest, param: string): Promise<ProbeResult> {
    const baseline = await replay(req, this.fetcher);
    const steps: ProbeStep[] = [];
    let suspicious = false;

    for (const p of PERTURBATIONS) {
      const variantReq: ReplayRequest = { ...req, url: perturbParam(req.url, param, p) };
      const response = await replay(variantReq, this.fetcher);
      const compareToBase = compareResponses(baseline, response);
      if (compareToBase.verdict === "suspicious") suspicious = true;
      steps.push({ label: `append ${p}`, request: variantReq, response, compareToBase });
    }

    return { param, baseline, steps, verdict: suspicious ? "suspicious" : "no_diff" };
  }
}
```

- [ ] **Step 5: 扩展 `packages/reasoning-core/src/index.ts`**

```ts
export { ProgressiveProber, type ProbeStep, type ProbeResult } from "./progressive-prober.js";
```

（保留现有导出）

- [ ] **Step 6: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/reasoning-core && pnpm --filter @traceforge/reasoning-core exec tsc --noEmit -p tsconfig.json`
Expected: progressive-prober 3 用例 + 现有用例全绿；tsc 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(reasoning-core): add ProgressiveProber for minimal-perturbation SQLi probing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: server —— 重放与探测路由（Scope Guard 守护）

**Files:**
- Modify: `apps/server/package.json`（加 `@traceforge/tools` 依赖）
- Modify: `apps/server/src/routes.ts`
- Test: `apps/server/src/routes-phase5.test.ts`

**Interfaces:**
- Consumes: `replay`/`Fetcher`（tools）、`ProgressiveProber`（reasoning-core）、`checkScope`（tool-resolver）、现有 `CaseStore`/`TimelineStore`/`EventBus`、`registerRoutes`。
- Produces：
  - `registerRoutes` 签名增加可选第 5 参 `fetcher?: Fetcher`（默认用 tools 的真实 fetcher；测试注入 mock）。
  - `POST /api/cases/:id/replay`：body `{ url, method, headers?, body? }`。取 case → `checkScope(url, scopeRules)`，越界 → emit `scope_violation` + 403。范围内 → `replay(req, fetcher)` → timeline(`replay`) → emit `timeline_appended` → 返回 ReplayResponse。
  - `POST /api/cases/:id/probe`：body `{ url, method, headers?, body?, param }`。同样先 Scope Guard（对 url 校验）。范围内 → `new ProgressiveProber(fetcher).probe(req, param)` → timeline(`probe: <verdict>`) → emit → 返回 ProbeResult。
  - 404 当 case 不存在。

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

// mock fetcher：单引号变体回 SQL 错误，其余回基线
const fetcher: Fetcher = async (req: ReplayRequest) =>
  req.url.includes("'")
    ? { status: 500, bodyLength: 40, body: "You have an error in your SQL syntax", headers: {} }
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

describe("probe route", () => {
  it("runs progressive probe and reports suspicious on db error", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/cases/${caseId}/probe`,
      payload: { url: "https://t.com/api/order?id=1001", method: "GET", param: "id" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).toBe("suspicious");
    expect(res.json().steps).toHaveLength(2);
  });

  it("rejects an out-of-scope probe with 403", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/cases/${caseId}/probe`,
      payload: { url: "https://evil.com/api?id=1", method: "GET", param: "id" },
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
import { replay, type Fetcher } from "@traceforge/tools";
import { ProgressiveProber } from "@traceforge/reasoning-core";
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
  app.post("/api/cases/:id/replay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { url: string; method: string; headers?: Record<string, string>; body?: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });
    const verdict = checkScope(body.url, c.scopeRules);
    if (!verdict.allowed) {
      bus.emit({ type: "scope_violation", caseId: id, url: body.url, reason: verdict.reason });
      return reply.code(403).send({ error: "out of scope", reason: verdict.reason });
    }
    const response = await replay({ url: body.url, method: body.method, headers: body.headers, body: body.body }, fetcher);
    const entry = timelineStore.append(id, "replay", `Replay ${body.method} ${body.url} → ${response.status}`);
    bus.emit({ type: "timeline_appended", entry });
    return response;
  });

  app.post("/api/cases/:id/probe", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { url: string; method: string; headers?: Record<string, string>; body?: string; param: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });
    const verdict = checkScope(body.url, c.scopeRules);
    if (!verdict.allowed) {
      bus.emit({ type: "scope_violation", caseId: id, url: body.url, reason: verdict.reason });
      return reply.code(403).send({ error: "out of scope", reason: verdict.reason });
    }
    const result = await new ProgressiveProber(replay.length, ).probe; // placeholder — see note
    void result;
    const prober = new ProgressiveProber((r) => replay(r, fetcher));
    const probeResult = await prober.probe(
      { url: body.url, method: body.method, headers: body.headers, body: body.body },
      body.param,
    );
    const entry = timelineStore.append(id, "probe", `Probe ${body.param} on ${body.url} → ${probeResult.verdict}`);
    bus.emit({ type: "timeline_appended", entry });
    return probeResult;
  });
```

> ⚠️ 上面 probe 路由里 `new ProgressiveProber(replay.length, )...` 是占位错误，实际实现只保留下面这段（删除占位两行）：
> ```ts
>   app.post("/api/cases/:id/probe", async (req, reply) => {
>     const { id } = req.params as { id: string };
>     const body = req.body as { url: string; method: string; headers?: Record<string, string>; body?: string; param: string };
>     const c = cases.get(id);
>     if (!c) return reply.code(404).send({ error: "case not found" });
>     const verdict = checkScope(body.url, c.scopeRules);
>     if (!verdict.allowed) {
>       bus.emit({ type: "scope_violation", caseId: id, url: body.url, reason: verdict.reason });
>       return reply.code(403).send({ error: "out of scope", reason: verdict.reason });
>     }
>     const prober = new ProgressiveProber((r) => replay(r, fetcher));
>     const probeResult = await prober.probe(
>       { url: body.url, method: body.method, headers: body.headers, body: body.body },
>       body.param,
>     );
>     const entry = timelineStore.append(id, "probe", `Probe ${body.param} on ${body.url} → ${probeResult.verdict}`);
>     bus.emit({ type: "timeline_appended", entry });
>     return probeResult;
>   });
> ```
> 注：`checkScope` 已在阶段 1 import；`cases`/`timelineStore` 已在函数体内初始化。ProgressiveProber 的 Fetcher 参数用闭包 `(r) => replay(r, fetcher)` 把可选 fetcher 透传。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run apps/server/src/routes-phase5.test.ts`
Expected: PASS（replay 范围内 200 / 越界 403+事件、probe suspicious / 越界 403）。

- [ ] **Step 6: tsc + 全量 server 测试**

Run: `pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json && pnpm vitest run apps/server`
Expected: tsc 退出码 0；server 全部测试（阶段 1-5）通过。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(server): add scope-guarded replay and progressive probe routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: web —— Replay 面板（重放 + 递进探测）

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: 阶段 5 路由、现有 web store/api。
- Produces：
  - `api.ts`：`replayRequest(caseId, req) → ReplayResponse`、`probeParam(caseId, req, param) → ProbeResult`（类型用 `@traceforge/tools` 与 `@traceforge/reasoning-core` 导出；web 已能 import workspace 包）。
  - `App.tsx`：在 Traffic 表格区下方新增 Replay 区块——一个 URL 输入框 + method + 「重放」按钮（显示返回 status / 长度），以及一个 param 输入 + 「递进探测」按钮（显示 verdict 与每步对比摘要）。结果用本地 React state（不强制走 store/WS，因为是即时请求-响应）。

- [ ] **Step 1: 扩展 `apps/web/src/api.ts`**

```ts
import type { ReplayResponse } from "@traceforge/tools";
import type { ProbeResult } from "@traceforge/reasoning-core";

export async function replayRequest(
  caseId: string,
  req: { url: string; method: string; headers?: Record<string, string>; body?: string },
): Promise<ReplayResponse> {
  return (await fetch(`/api/cases/${caseId}/replay`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req),
  })).json();
}

export async function probeParam(
  caseId: string,
  req: { url: string; method: string; param: string },
): Promise<ProbeResult> {
  return (await fetch(`/api/cases/${caseId}/probe`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req),
  })).json();
}
```

- [ ] **Step 2: 扩展 `apps/web/src/App.tsx`**

import 加 `replayRequest, probeParam`，并在组件内加本地 state：

```tsx
  const [replayUrl, setReplayUrl] = useState("https://example.com/");
  const [replayMethod, setReplayMethod] = useState("GET");
  const [replayResult, setReplayResult] = useState<string>("");
  const [probeUrl, setProbeUrl] = useState("https://example.com/?id=1");
  const [probeParamName, setProbeParamName] = useState("id");
  const [probeVerdict, setProbeVerdict] = useState<string>("");
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

      <h3>递进探测</h3>
      <input value={probeUrl} onChange={(e) => setProbeUrl(e.target.value)} style={{ width: 320 }} />
      <input value={probeParamName} onChange={(e) => setProbeParamName(e.target.value)} style={{ width: 60 }} />
      <button onClick={async () => {
        const r = await probeParam(caseId, { url: probeUrl, method: "GET", param: probeParamName });
        setProbeVerdict(`${r.verdict} (${r.steps.map((s) => s.label + ":" + (s.compareToBase?.verdict ?? "?")).join(", ")})`);
      }}>递进探测</button>
      <span> {probeVerdict}</span>
```

- [ ] **Step 3: tsc + 构建**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 退出码 0；Vite 构建成功。

- [ ] **Step 4: 端到端验证（真实 fetch 打公网，仅验证 Scope Guard 与重放成功）**

Run（确认 4000 空闲；用真实 fetcher 打 example.com，验证范围内重放成功 + 越界 403）：

```bash
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('e2e.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 5
CID=$(curl -s -X POST localhost:4000/api/cases -H 'content-type: application/json' -d '{"name":"p5","allowHosts":["example.com"]}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "in-scope replay: $(curl -s -X POST localhost:4000/api/cases/$CID/replay -H 'content-type: application/json' -d '{"url":"https://example.com/","method":"GET"}' | grep -o '"status":[0-9]*')"
echo "out-of-scope replay code: $(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:4000/api/cases/$CID/replay -H 'content-type: application/json' -d '{"url":"https://evil.com/","method":"GET"}')"
# 清理后端进程与 e2e.sqlite*
```
Expected: in-scope replay 返回含 `"status":200`（example.com 实际响应）；out-of-scope code 403。SQLi suspicious 判定逻辑已由 Task 2/3 的 mock 测试覆盖（不依赖真实有漏洞的目标）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): add Replay panel with request replay and progressive probe

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 阶段收尾 —— 全量校验与 README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: PASS —— 阶段 1-4（63）+ 阶段 5（tools 5、reasoning-core progressive 3、server routes-phase5 4）全绿。

- [ ] **Step 2: 全量构建**

Run: `pnpm -r build`
Expected: 各包无错误（新增 `@traceforge/tools`）。

- [ ] **Step 3: 更新 `README.md`**

"当前进度"标题改为"阶段 0 + 1 + 2 + 3 + 4 + 5"，追加：

```markdown
- HTTP 重放与递进式验证：改参数重发请求 + 响应对比；递进式最小扰动探测（基线 → 单/双引号 → 对比，给出 suspicious/no-diff），所有对外请求受 Scope Guard 守护（越界 403）
```

把测试数量更新为实际值。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README for phase 5 (http replay + progressive verification)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：对应设计文档第 21 章「阶段 5：HTTP Replay 与递进式验证」交付物（HttpReplayTool、ResponseCompare、MinimalPerturbation Workflow），并落实 11.3 工具接口的核心（replay + compareResponses）与 7.2 递进式场景。`http.sendRaw`/`modifyParam` 的完整面留待需要时补；本阶段以 replay + 参数扰动覆盖核心。
- **类型一致性**：`ReplayRequest`/`ReplayResponse`/`Fetcher`/`CompareResult` 单源于 `@traceforge/tools`（Task 1），reasoning-core（Task 2）与 server（Task 3）与 web（Task 4）均消费同一份。`ProbeResult` 源于 reasoning-core（Task 2），server/web 复用。`registerRoutes` 第 5 参 `fetcher?` 在 Task 3 定义，测试注入 mock、生产用默认真实 fetcher。
- **安全约束落点**：(a) Scope Guard 守门——replay/probe 路由发请求前都 `checkScope`，越界 403 + emit scope_violation，由 Task 3 的两个 403 测试守住；(b) 递进式硬规则——PERTURBATIONS 固定 `['", "\"']`，不做批量 payload，由 Task 2 的"只发 3 次"测试守住；(c) 纯逻辑可测——compareResponses/ProgressiveProber 不直接联网，发送经注入 Fetcher，单测全用 mock。
- **重放不走人工确认**：按用户决定，重放是低风险动作，范围内直接发，Scope Guard 是唯一强制门（对齐设计文档 3.4「高价值或可能产生影响的动作」才需确认，重放不属于）。
- **已知简化**：探测最小扰动集仅 `'`/`"`（递进式第一档）；更深的扰动（布尔盲注、时间盲注、sqlmap 调用）属后续阶段/工具插件（23.3）。response body 全量返回给前端，长 body 截断属第 25 章上下文管理，后续处理。真实 fetch 无超时/重试控制，本阶段简化；生产化时加 AbortController 超时。
