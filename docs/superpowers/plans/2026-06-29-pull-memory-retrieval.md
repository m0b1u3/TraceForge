# Pull 式记忆检索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把认知内核的 Layer2 Fact 预塑（relevanceScore topK）改为 4 个 agent 检索工具（search_facts/get_fact_detail/search_traffic/recall_conversation），检索决策权交还 LLM（pull 式，Claude Code 形态）。

**Architecture:** 新增公共关键词打分纯函数 + 4 个检索工具（复用现有 store 方法），ContextBuilder 瘦身（删 Layer2 Fact 预塑、入参 facts[]→count、Layer1 加资源清单行），routes.ts 注册工具并改 buildContext 调用。

**Tech Stack:** TypeScript ESM strict（verbatimModuleSyntax，类型导入 `import type`）、Zod schema 单源在 @traceforge/shared、Vitest。

## Global Constraints

- 最高原则「LLM 主导、零硬编码」：检索决策权交还 LLM，去掉代码替 LLM 猜相关性的预塑。
- 工具模式：`make<Name>Tool(caseId, reader): ToolDescriptor`，ToolDescriptor 形状见 packages/extension/src/tool.ts：`{ name, description, inputSchema, risk: "normal"|"command", source, execute: (input)=>Promise<{ok,content,meta?}> }`。写操作走注入接口便于单测。样板见 packages/extension/src/case-tools.ts。
- 检索工具 risk=normal（只读，不对外发包）。
- 容错降级不崩：无命中返 ok:true（空结果是正常信息）；id 不存在返 ok:false；任何 execute 抛错不中断 run。
- 第一版关键词检索，不引入向量库（留 keywordScore→embedding 升级接口）。
- relevanceScore.ts 不删（保留作升级锚点）。
- 不改 SessionState/Hypothesis/Compressor/3 认知工具/前端。
- 提交信息结尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`，master 直接 commit。

---

## File Structure

- **Create** `packages/reasoning-core/src/keyword-search.ts` — keywordScore 公共纯函数（4 工具共用）。
- **Create** `packages/extension/src/memory-tools.ts` — 4 个检索工具 + 注入接口。
- **Modify** `packages/reasoning-core/src/index.ts` — 导出 keyword-search。
- **Modify** `packages/extension/src/index.ts` — 导出 memory-tools。
- **Modify** `packages/reasoning-core/src/context-builder.ts` — 瘦身：删 Layer2 Fact 预塑、入参 facts[]→factCount/trafficCount/summaryCount、Layer1 加资源清单、injectedFactIds 恒空。
- **Modify** `packages/reasoning-core/src/context-builder.test.ts` — 既有测试随入参改造更新。
- **Modify** `apps/server/src/routes.ts` — 注册 4 工具 + 改 buildContext 调用。
- **Modify** `apps/server/src/routes-cognitive.test.ts` — 加端到端 pull 检索测试。

---

## Task A: keyword-search.ts 公共关键词打分

**Files:**
- Create: `packages/reasoning-core/src/keyword-search.ts`
- Test: `packages/reasoning-core/src/keyword-search.test.ts`
- Modify: `packages/reasoning-core/src/index.ts`

**Interfaces:**
- Produces: `keywordScore(query: string, text: string): number`（query/text 做 bigram，命中数即分；单字 query 用 includes；空输入返 0）

- [ ] **Step 1: 写失败测试**

```ts
// packages/reasoning-core/src/keyword-search.test.ts
import { describe, it, expect } from "vitest";
import { keywordScore } from "./keyword-search.js";

describe("keywordScore", () => {
  it("empty query or text returns 0", () => {
    expect(keywordScore("", "abc")).toBe(0);
    expect(keywordScore("abc", "")).toBe(0);
  });
  it("single-char query uses includes", () => {
    expect(keywordScore("a", "banana")).toBe(1);
    expect(keywordScore("z", "banana")).toBe(0);
  });
  it("multi-char query counts bigram hits", () => {
    // query "login" bigrams: lo og gi in ; text 含 "login" 全部命中
    expect(keywordScore("login", "the login endpoint")).toBeGreaterThan(0);
    expect(keywordScore("login", "unrelated text")).toBe(0);
  });
  it("matches chinese continuous string", () => {
    expect(keywordScore("登录越权", "登录接口")).toBeGreaterThan(0);
  });
  it("is case-insensitive", () => {
    expect(keywordScore("LOGIN", "login here")).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/keyword-search.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// packages/reasoning-core/src/keyword-search.ts
// query 与 text 都做 bigram，命中数即分。支持中文连续串。单字 query 直接 includes。
// 第一版关键词检索；预留升级：换向量时把本函数替换为 embedding 相似度，调用方不变。
export function keywordScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/[\s,，。/]+/g, "");
  const t = text.toLowerCase();
  if (!q || !t) return 0;
  if (q.length === 1) return t.includes(q) ? 1 : 0;
  const grams = new Set<string>();
  for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2));
  let hits = 0;
  for (const g of grams) if (t.includes(g)) hits++;
  return hits;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/keyword-search.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 从 index 导出**

在 `packages/reasoning-core/src/index.ts` 追加（先 Read 看现有 export 风格）：

```ts
export * from "./keyword-search.js";
```

- [ ] **Step 6: build + Commit**

Run: `pnpm --filter @traceforge/reasoning-core build`（exit 0）

```bash
git add packages/reasoning-core/src/keyword-search.ts packages/reasoning-core/src/keyword-search.test.ts packages/reasoning-core/src/index.ts
git commit -m "feat(pull-memory): keywordScore 公共关键词打分纯函数"
```

---

## Task B: memory-tools.ts 4 个检索工具

**Files:**
- Create: `packages/extension/src/memory-tools.ts`
- Test: `packages/extension/src/memory-tools.test.ts`
- Modify: `packages/extension/src/index.ts`

**Interfaces:**
- Consumes: `keywordScore`（Task A，从 @traceforge/reasoning-core 导入）；`ToolDescriptor`（./tool.js）；`Fact`/`TrafficEntry`/`AgentEvent`（@traceforge/shared，仅类型）
- Produces:
  - `interface FactSearchReader { listByCase(caseId: string): Fact[] }`
  - `interface FactDetailReader { getById(id: string): Fact | undefined }`
  - `interface TrafficSearchReader { listByCase(caseId: string): TrafficEntry[] }`
  - `interface ConvoSearchReader { listByCase(caseId: string): AgentEvent[] }`
  - `interface SummaryReader { latest(caseId: string): { content: string } | undefined }`
  - `makeSearchFactsTool(caseId, facts: FactSearchReader): ToolDescriptor`
  - `makeGetFactDetailTool(caseId, facts: FactDetailReader): ToolDescriptor`
  - `makeSearchTrafficTool(caseId, traffic: TrafficSearchReader): ToolDescriptor`
  - `makeRecallConversationTool(caseId, events: ConvoSearchReader, summaries: SummaryReader): ToolDescriptor`

**注意**：packages/extension 当前是否依赖 @traceforge/reasoning-core？先 Read packages/extension/package.json 确认。若没有依赖，加 `"@traceforge/reasoning-core": "workspace:*"` 到 dependencies 并 `pnpm install`。（若担心循环依赖：reasoning-core 不依赖 extension，方向是 extension→reasoning-core，安全。）

- [ ] **Step 1: 写失败测试**

```ts
// packages/extension/src/memory-tools.test.ts
import { describe, it, expect } from "vitest";
import {
  makeSearchFactsTool, makeGetFactDetailTool, makeSearchTrafficTool, makeRecallConversationTool,
} from "./memory-tools.js";
import type { Fact, TrafficEntry, AgentEvent } from "@traceforge/shared";

function fact(p: Partial<Fact>): Fact {
  return { id: "f", caseId: "c", type: "note", title: "t", value: {}, source: { type: "manual", ref: "x" }, confidence: 1, tags: [], createdAt: "2026-01-01T00:00:00Z", updateCount: 0, updatedAt: "", validity: "valid", ...p } as Fact;
}

describe("search_facts", () => {
  const facts = {
    listByCase: () => [
      fact({ id: "f1", type: "login_endpoint", title: "/api/login" }),
      fact({ id: "f2", type: "api_endpoint", title: "/api/order", value: { hint: "越权线索" } }),
      fact({ id: "f3", type: "note", title: "无关页面" }),
    ],
  };
  it("matches by title/type and returns id summaries", async () => {
    const t = makeSearchFactsTool("c", facts);
    const r = await t.execute({ query: "login" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("f1");
    expect(r.content).not.toContain("f3");
  });
  it("searches inside value (not just title)", async () => {
    const t = makeSearchFactsTool("c", facts);
    const r = await t.execute({ query: "越权" });
    expect(r.content).toContain("f2"); // 命中在 value.hint
  });
  it("empty result returns ok:true with hint", async () => {
    const t = makeSearchFactsTool("c", facts);
    const r = await t.execute({ query: "zzzznomatch" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("没有匹配");
  });
});

describe("get_fact_detail", () => {
  const facts = { getById: (id: string) => (id === "f1" ? fact({ id: "f1", title: "x", value: { k: "v" } }) : undefined) };
  it("returns full value for existing id", async () => {
    const t = makeGetFactDetailTool("c", facts);
    const r = await t.execute({ id: "f1" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("\"k\"");
  });
  it("missing id returns ok:false", async () => {
    const t = makeGetFactDetailTool("c", facts);
    const r = await t.execute({ id: "nope" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("未找到");
  });
});

describe("search_traffic", () => {
  const traffic = {
    listByCase: (): TrafficEntry[] => [
      { id: "t1", caseId: "c", url: "https://x/api/order", method: "GET", requestHeaders: {}, responseStatus: 200, responseBody: null, createdAt: "t" },
      { id: "t2", caseId: "c", url: "https://x/static/logo.png", method: "GET", requestHeaders: {}, responseStatus: 200, responseBody: null, createdAt: "t" },
    ],
  };
  it("matches by url", async () => {
    const t = makeSearchTrafficTool("c", traffic);
    const r = await t.execute({ query: "order" });
    expect(r.content).toContain("t1");
    expect(r.content).not.toContain("t2");
  });
});

describe("recall_conversation", () => {
  const events = {
    listByCase: (): AgentEvent[] => [
      { id: "e1", caseId: "c", kind: "user", text: "测试登录越权", tool: null, createdAt: "t" },
      { id: "e2", caseId: "c", kind: "done", text: "已记录订单接口", tool: null, createdAt: "t" },
    ],
  };
  const summaries = { latest: () => ({ content: "早期发现了 3 个 API" }) };
  it("matches conversation events by query", async () => {
    const t = makeRecallConversationTool("c", events, summaries);
    const r = await t.execute({ query: "登录" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("测试登录越权");
  });
  it("includes summary when it matches", async () => {
    const t = makeRecallConversationTool("c", events, summaries);
    const r = await t.execute({ query: "API" });
    expect(r.content).toContain("早期发现");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @traceforge/extension exec vitest run src/memory-tools.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// packages/extension/src/memory-tools.ts
import { keywordScore } from "@traceforge/reasoning-core";
import type { Fact, TrafficEntry, AgentEvent } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export interface FactSearchReader { listByCase(caseId: string): Fact[] }
export interface FactDetailReader { getById(id: string): Fact | undefined }
export interface TrafficSearchReader { listByCase(caseId: string): TrafficEntry[] }
export interface ConvoSearchReader { listByCase(caseId: string): AgentEvent[] }
export interface SummaryReader { latest(caseId: string): { content: string } | undefined }

function clip(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

export function makeSearchFactsTool(caseId: string, facts: FactSearchReader): ToolDescriptor {
  return {
    name: "search_facts",
    description: "按关键词检索本 Case 已记录的 Fact（接口/凭据/漏洞线索等），搜索范围含类型/标题/内容/标签。返回命中的 id+类型+标题摘要；要完整内容用 get_fact_detail(id)。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    risk: "normal", source: "builtin",
    execute: async (input) => {
      const { query, limit = 10 } = (input ?? {}) as { query?: string; limit?: number };
      if (!query) return { ok: false, content: "缺少 query" };
      const hits = facts.listByCase(caseId)
        .map((f) => ({ f, s: keywordScore(query, `${f.type} ${f.title} ${JSON.stringify(f.value)} ${f.tags.join(" ")}`) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
      if (hits.length === 0) return { ok: true, content: `没有匹配“${query}”的 Fact` };
      return { ok: true, content: `${hits.map((h) => `${h.f.id} [${h.f.type}] ${h.f.title}`).join("\n")}\n（用 get_fact_detail(id) 看完整内容）` };
    },
  };
}

export function makeGetFactDetailTool(caseId: string, facts: FactDetailReader): ToolDescriptor {
  void caseId;
  return {
    name: "get_fact_detail",
    description: "按 id 取一条 Fact 的完整内容（含 value/source/confidence/tags）。先用 search_facts 找到 id。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    risk: "normal", source: "builtin",
    execute: async (input) => {
      const { id } = (input ?? {}) as { id?: string };
      if (!id) return { ok: false, content: "缺少 id" };
      const f = facts.getById(id);
      if (!f) return { ok: false, content: `未找到 Fact ${id}` };
      return { ok: true, content: JSON.stringify({ type: f.type, title: f.title, value: f.value, source: f.source, confidence: f.confidence, tags: f.tags, validity: f.validity }, null, 2) };
    },
  };
}

export function makeSearchTrafficTool(caseId: string, traffic: TrafficSearchReader): ToolDescriptor {
  return {
    name: "search_traffic",
    description: "按关键词检索本 Case 已捕获的 HTTP 流量（搜 url/method/状态码）。返回命中的 id+method+状态+url；要 headers/body 用 get_traffic(id)。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    risk: "normal", source: "builtin",
    execute: async (input) => {
      const { query, limit = 10 } = (input ?? {}) as { query?: string; limit?: number };
      if (!query) return { ok: false, content: "缺少 query" };
      const hits = traffic.listByCase(caseId)
        .map((e) => ({ e, s: keywordScore(query, `${e.url} ${e.method} ${e.responseStatus ?? ""}`) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
      if (hits.length === 0) return { ok: true, content: `没有匹配“${query}”的流量` };
      return { ok: true, content: `${hits.map((h) => `${h.e.id} ${h.e.method} ${h.e.responseStatus ?? "-"} ${h.e.url}`).join("\n")}\n（用 get_traffic(id) 看 headers/body）` };
    },
  };
}

export function makeRecallConversationTool(caseId: string, events: ConvoSearchReader, summaries: SummaryReader): ToolDescriptor {
  return {
    name: "recall_conversation",
    description: "按关键词检索更早的（已滚出近期窗口的）历史对话与远期摘要。想不起之前讨论过什么时用。",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    risk: "normal", source: "builtin",
    execute: async (input) => {
      const { query, limit = 10 } = (input ?? {}) as { query?: string; limit?: number };
      if (!query) return { ok: false, content: "缺少 query" };
      const hits = events.listByCase(caseId)
        .filter((e) => e.kind === "user" || e.kind === "text" || e.kind === "done")
        .map((e) => ({ e, s: keywordScore(query, e.text) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
      const parts: string[] = [];
      if (hits.length) parts.push(hits.map((h) => `[${h.e.kind}] ${clip(h.e.text)}`).join("\n"));
      const sum = summaries.latest(caseId);
      if (sum && keywordScore(query, sum.content) > 0) parts.push(`远期摘要相关段：${clip(sum.content, 200)}`);
      if (parts.length === 0) return { ok: true, content: `没有匹配“${query}”的历史对话` };
      return { ok: true, content: parts.join("\n\n") };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @traceforge/extension exec vitest run src/memory-tools.test.ts`
Expected: PASS（9 tests）

- [ ] **Step 5: 从 index 导出**

在 `packages/extension/src/index.ts` 追加：

```ts
export * from "./memory-tools.js";
```

- [ ] **Step 6: build + Commit**

Run: `pnpm --filter @traceforge/extension build`（exit 0）

```bash
git add packages/extension/src/memory-tools.ts packages/extension/src/memory-tools.test.ts packages/extension/src/index.ts packages/extension/package.json pnpm-lock.yaml
git commit -m "feat(pull-memory): 4 个检索工具 search_facts/get_fact_detail/search_traffic/recall_conversation"
```

---

## Task C: ContextBuilder 瘦身

**Files:**
- Modify: `packages/reasoning-core/src/context-builder.ts`
- Modify: `packages/reasoning-core/src/context-builder.test.ts`

**Interfaces:**
- Changes: `ContextInput` 的 `facts: Fact[]` 删除，新增 `factCount: number`、`trafficCount: number`、`summaryCount: number`；删除 `protectedFactIds: Set<string>`。`BuildResult.injectedFactIds` 保留但恒为 `[]`。
- Consumes: 不再用 topK/relevanceScore（移除 import）；estimateTokens 保留。

- [ ] **Step 1: 先 Read 现状**

Read `packages/reasoning-core/src/context-builder.ts` 全文 + `context-builder.test.ts` 全文，看清现有 ContextInput 字段、buildLayer2 实现、4 个既有测试（含「protected fact 保留」「degrades when over budget」）。

- [ ] **Step 2: 改测试（先让测试反映新行为）**

把 `context-builder.test.ts` 改为：
- `base` 输入：删 `facts`/`protectedFactIds`，加 `factCount: 1, trafficCount: 0, summaryCount: 0`。
- 删除「protected fact is kept」用例（pull 式不再预塑 Fact，protected 概念移除）。
- 删除「includes in-scope fact id and records injectedFactIds」用例（不再注入 Fact）。
- 改「expands recent conversation」用例：保留（Layer1 近期对话行为不变）。
- 改「degrades when over budget」用例：保留，但 base 用新字段；断言不变（降级仍靠 Layer3/截断）。
- 新增用例「resource inventory line present」：
```ts
it("includes resource inventory line with counts", () => {
  const r = buildContext({ ...base, factCount: 23, trafficCount: 8, summaryCount: 2 }, budget);
  const ctxMsg = r.messages[0].content;
  expect(ctxMsg).toContain("23");
  expect(ctxMsg).toContain("search_facts");
});
it("injectedFactIds is always empty (pull mode)", () => {
  const r = buildContext({ ...base, factCount: 5 }, budget);
  expect(r.injectedFactIds).toEqual([]);
});
```
（完整 base 示例——实现者照此构造，删除 facts/protectedFactIds：）
```ts
const base: ContextInput = {
  goal: "测越权", state: undefined,
  recentConvo: [{ role: "user", text: "测 a.com" }, { role: "assistant", text: "已提议纳入 a.com" }],
  factCount: 1, trafficCount: 0, summaryCount: 0,
  activeHypotheses: [], activeTasks: [], doneTaskSummaries: [], farSummary: undefined,
  scopeHosts: ["a.com"],
};
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/context-builder.test.ts`
Expected: FAIL（ContextInput 类型不匹配 / 资源清单未实现）

- [ ] **Step 4: 改实现 context-builder.ts**

- 移除 `import { topK, type Focus } from "./relevance.js"`（若 Focus 不再用）。移除 `import type { Fact } from`（若 facts 字段删后不再引用 Fact 类型）。
- `ContextInput`：删 `facts: Fact[]` 和 `protectedFactIds: Set<string>`；加 `factCount: number; trafficCount: number; summaryCount: number;`。
- 删 `focusFrom` 中对 relevance Focus 的使用（若仅服务 topK），及整个 `buildLayer2` 里的 `topK(...)` Fact 选取逻辑。
- `buildLayer2` 改为只组装活跃假设（不再有 Fact）：
```ts
const buildLayer2 = (): string => {
  if (!input.activeHypotheses.length) return "";
  return `活跃假设：\n${input.activeHypotheses.map((h) => `- ${h.id} [${h.status}] ${h.statement}`).join("\n")}`;
};
```
- Layer1 加资源清单行（在 stateLine/scopeLine/taskLine 之后）：
```ts
const inventoryLine = `📁 本 Case 已积累：${input.factCount} 个 Fact、${input.trafficCount} 条流量、${input.summaryCount} 条远期对话摘要。需要历史发现时用 search_facts("关键词") / search_traffic(...) / recall_conversation(...) 检索；要某 Fact 细节用 get_fact_detail(id)。`;
```
- assemble 的 sections 改为 `[stateLine, scopeLine, taskLine, inventoryLine, layer2, layer3]`（layer2 为空串时不加入）。
- 降级：Layer2 不再有 K（无 Fact），删「降级 2 降 K」那段 while 循环，保留「降级 1 砍 Layer3」+「降级 3 截断」。degraded 仍记录。
- `return` 的 `injectedFactIds: []`（恒空）。
- 因不再依赖 topK，相关 import 清理干净，build 不能有未使用变量报错。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @traceforge/reasoning-core exec vitest run src/context-builder.test.ts`
Expected: PASS

- [ ] **Step 6: build + Commit**

Run: `pnpm --filter @traceforge/reasoning-core build`（exit 0）

```bash
git add packages/reasoning-core/src/context-builder.ts packages/reasoning-core/src/context-builder.test.ts
git commit -m "feat(pull-memory): ContextBuilder 瘦身（删 Layer2 Fact 预塑，加资源清单，入参改 count）"
```

---

## Task D: 接线 routes.ts

**Files:**
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/routes-cognitive.test.ts`

**Interfaces:**
- Consumes: 4 工具工厂（Task B，从 @traceforge/extension）；瘦身后的 buildContext（Task C）。

- [ ] **Step 1: 先 Read routes.ts 的 agent/run handler**

Read `apps/server/src/routes.ts` 约 200-300 行，定位：registry.register 区、buildContext 调用区（约 264-282）。确认 factStore/traffic/agentEventStore/contextSummaryStore 已在作用域（它们在 registerRoutes 顶部已构造）。

- [ ] **Step 2: 写失败集成测试**

在 `apps/server/src/routes-cognitive.test.ts` 追加：

```ts
import { FactStore } from "./stores/fact-store.js"; // 若文件顶部已 import 可省

describe("pull-mode fact retrieval", () => {
  it("agent can search facts via search_facts tool", async () => {
    // 先用 POST /api/cases/:id/facts 落一个 fact（或直接 new FactStore(db) 写入——优先走 API）
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/facts`, payload: { type: "login_endpoint", title: "/api/login", value: {} } });
    // MockProvider 第一轮调 search_facts，第二轮 done
    // —— 见下方说明：需要让 beforeEach 的 provider 产出一个 search_facts 工具调用
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "找登录接口" } });
    expect(res.statusCode).toBe(200);
    const events = (await app.inject({ url: `/api/cases/${caseId}/agent/events` })).json();
    const toolResults = events.filter((e: { kind: string }) => e.kind === "tool_result").map((e: { text: string }) => e.text);
    expect(toolResults.some((t: string) => t.includes("/api/login"))).toBe(true);
  });
});
```
**说明**：beforeEach 现有 MockProvider 只产 done turn。为测 search_facts，需在本 describe 内用独立 app/provider：provider 第一轮返回 `{ text:"", toolCalls:[{id:"c1",name:"search_facts",input:{query:"登录"}}], done:false }`，第二轮 `{ text:"找到了", toolCalls:[], done:true }`。Read routes-cognitive.test.ts 现有 beforeEach 看 MockProvider 构造法，在本 describe 用 beforeEach 覆盖或新建独立 app 实例（参照 compressor 测试里「fresh createDb + fresh Fastify」的隔离做法）。断言核心：tool_result 事件里出现了 search_facts 命中的 fact 标题 `/api/login`。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @traceforge/server exec vitest run`
Expected: 新测试 FAIL（search_facts 工具未注册）

- [ ] **Step 4: 改实现 routes.ts**

（a）import 区追加（与现有 @traceforge/extension import 合并）：
```ts
import { makeSearchFactsTool, makeGetFactDetailTool, makeSearchTrafficTool, makeRecallConversationTool } from "@traceforge/extension";
```
（b）agent/run 的 registry.register 区追加 4 工具：
```ts
registry.register(makeSearchFactsTool(id, factStore));
registry.register(makeGetFactDetailTool(id, factStore));
registry.register(makeSearchTrafficTool(id, traffic));
registry.register(makeRecallConversationTool(id, agentEventStore, contextSummaryStore));
```
（c）改 buildContext 调用（删 facts/protectedFactIds/evidenceRefIds，加 count）：
```ts
const built = buildContext({
  goal,
  state: sessionStore.get(id),
  recentConvo,
  factCount: factStore.listByCase(id).length,
  trafficCount: traffic.listByCase(id).length,
  summaryCount: contextSummaryStore.latest(id) ? 1 : 0,
  activeHypotheses: hypothesisStore.listByCase(id).filter((h) => h.status === "open"),
  activeTasks: taskStore.listByCase(id).filter((t) => ["open", "blocked", "running", "recheck_candidate"].includes(t.status)),
  doneTaskSummaries: taskStore.listByCase(id).filter((t) => t.status === "done").map((t) => `${t.title}：${t.reason || "完成"}`),
  farSummary: contextSummaryStore.latest(id)?.content,
  scopeHosts: c.scopeRules.flatMap((r) => r.allowHosts),
}, { maxTokens: 60000, focusReserve: 3000 });
```
删除原先 `const evidenceRefIds = new Set(actionStore.listByCase(id).flatMap((a) => a.evidenceRefs));`（若仅服务 buildContext；确认 actionStore 这行别处没用到再删）。
（d）context_built timeline 行：`built.injectedFactIds.length` 现在恒 0，保留该行无害（或改文案为 `注入上下文, ~${built.estimatedTokens} tokens, 降级:...`）。

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter @traceforge/server exec vitest run`（新测试 PASS）
Run: `pnpm test`（全过）
Run: `pnpm -r build`（全部 exit 0）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes.ts apps/server/src/routes-cognitive.test.ts
git commit -m "feat(pull-memory): agent/run 注册 4 检索工具 + buildContext 改传 count（pull 式生效）"
```

---

## 收尾验证（全部任务完成后）

- [ ] `pnpm test` 全过
- [ ] `pnpm -r build` 全部 exit 0
- [ ] 手测：建 Case → 记几个 Fact → 给 agent 目标 → 观察 agent 是否主动调 search_facts 而非被预塑（事件流里出现 search_facts tool_call）
- [ ] 更新 README 进度段 + 设计文档（pull 式记忆检索）+ traceforge-plan-execution 记忆

## Spec 覆盖自检

- §2 ContextBuilder 瘦身 → Task C；4 工具 → Task B；keywordScore → Task A；接线 → Task D ✓
- §4.1-4.4 四工具签名 → Task B（含 search 含 value、detail 完整、traffic 搜 url、recall 搜 events+summary、空结果 ok:true、下一步提示）✓
- §5 入参 facts→count、资源清单、injectedFactIds 恒空 → Task C ✓
- §7 容错（无命中 ok:true、id 不存在 ok:false）→ Task B 测试覆盖 ✓
- §10 不删 relevanceScore（Task C 仅移除其在 ContextBuilder 的调用，文件保留）✓
