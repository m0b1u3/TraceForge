# TraceForge 阶段 0 + 阶段 1：脚手架、Scope Guard 与抓包闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 立起 pnpm monorepo 骨架，落地 Scope Guard 安全地基（含单元测试），并跑通"创建 Case → 打开站点 → 捕获请求响应 → HTTP History 展示"的最小闭环。

**Architecture:** 单仓 monorepo（pnpm workspace）。后端 Fastify + WebSocket 事件总线 + SQLite（Drizzle ORM），用 Playwright 驱动浏览器并通过 CDP/路由拦截捕获流量。前端 Vite + React + Zustand，通过 WebSocket 订阅事件实时刷新 Traffic Panel。所有对外动作（首个即"打开 URL"）必须先过 Scope Guard 校验。AI 第一版接 Anthropic Claude（`claude-opus-4-8`），但本阶段不调用 LLM——仅预留 provider 抽象。

**Tech Stack:** TypeScript、pnpm、Fastify、`@fastify/websocket`、better-sqlite3 + Drizzle ORM、Playwright、Zod、Vite、React、Zustand、Vitest。

## Global Constraints

- Node.js ≥ 22（已验证本机 v22.15.0）；pnpm ≥ 9（已验证 9.15.9）。
- 包管理统一用 pnpm；workspace 协议 `workspace:*` 引用内部包。
- 语言统一 TypeScript，`"type": "module"`（ESM），`strict: true`。
- 所有共享数据结构（Fact / Task / ScopeRule / RuntimeEvent 等）定义在 `packages/shared`，用 Zod schema 并由其 `z.infer` 导出类型——禁止在多处重复定义。
- 测试框架统一 Vitest；纯逻辑模块（Scope Guard 等）必须有单元测试。
- AI Provider 第一版为 Anthropic，模型 ID 字符串固定 `claude-opus-4-8`；本阶段只建抽象与配置，不发起真实调用。
- 数据库第一版 SQLite，所有业务表带 `case_id`（呼应设计文档第 28 章）。
- 任何对外网络动作（浏览器导航、未来的 HTTP 重放）执行前必须经 Scope Guard 校验；越界即拒绝。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: Monorepo 骨架与工具链

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `vitest.config.ts`
- Create: `.npmrc`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: 一个可运行 `pnpm install`、`pnpm -r build`、`pnpm test` 的 workspace 根。`tsconfig.base.json` 导出供各包 `extends` 的严格编译配置。

- [ ] **Step 1: 初始化 git 仓库（环境非 git 仓库）**

Run:
```bash
cd "E:/learn/TraceForge" && git init && git add TraceForge_design.md docs && git commit -m "chore: initial design docs"
```
Expected: 成功创建仓库并产生首个提交。

- [ ] **Step 2: 写 `.gitignore`**

```gitignore
node_modules/
dist/
*.log
cases/
.venv/
*.sqlite
*.sqlite-journal
.DS_Store
```

- [ ] **Step 3: 写 `.npmrc`（保证 Playwright/better-sqlite3 原生依赖可被提升）**

```ini
node-linker=hoisted
strict-peer-dependencies=false
```

- [ ] **Step 4: 写 `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 5: 写根 `package.json`**

```json
{
  "name": "traceforge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev:server": "pnpm --filter @traceforge/server dev",
    "dev:web": "pnpm --filter @traceforge/web dev"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 6: 写 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 7: 写 `vitest.config.ts`（根级，聚合所有包测试）**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 8: 安装并验证空 workspace**

Run:
```bash
cd "E:/learn/TraceForge" && pnpm install && pnpm test
```
Expected: 安装成功；`pnpm test` 报 "No test files found" 但退出码为 0（Vitest 无测试时通过）。若退出码非 0，加 `passWithNoTests: true` 到 vitest 配置。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo with typescript and vitest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: shared 包 —— 核心 Zod schema 与类型

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/schemas.ts`
- Create: `packages/shared/src/events.ts`
- Test: `packages/shared/src/schemas.test.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json`（Task 1）。
- Produces:
  - `ScopeRule` 类型 + `ScopeRuleSchema`：`{ caseId: string; allowHosts: string[]; denyHosts: string[] }`
  - `Case` 类型 + `CaseSchema`：`{ id, name, status: "active"|"paused"|"archived", scopeRules: ScopeRule[], createdAt }`
  - `TrafficEntry` 类型 + `TrafficEntrySchema`：`{ id, caseId, url, method, requestHeaders, responseStatus, responseBody, createdAt }`
  - `RuntimeEvent` 联合类型（`events.ts`）：含 `case_created`、`request_captured`、`response_captured`、`scope_violation`。
  - 包名 `@traceforge/shared`，导出上述全部符号。

- [ ] **Step 1: 写 `packages/shared/package.json`**

```json
{
  "name": "@traceforge/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "zod": "^3.24.0" }
}
```

- [ ] **Step 2: 写 `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: 写失败测试 `packages/shared/src/schemas.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ScopeRuleSchema, CaseSchema, TrafficEntrySchema } from "./schemas.js";

describe("ScopeRuleSchema", () => {
  it("accepts a valid scope rule", () => {
    const rule = { caseId: "case_1", allowHosts: ["example.com"], denyHosts: [] };
    expect(ScopeRuleSchema.parse(rule)).toEqual(rule);
  });

  it("rejects a rule missing allowHosts", () => {
    expect(() => ScopeRuleSchema.parse({ caseId: "case_1", denyHosts: [] })).toThrow();
  });
});

describe("CaseSchema", () => {
  it("defaults status to active", () => {
    const c = CaseSchema.parse({
      id: "case_1",
      name: "demo",
      scopeRules: [],
      createdAt: "2026-06-23T00:00:00Z",
    });
    expect(c.status).toBe("active");
  });
});

describe("TrafficEntrySchema", () => {
  it("requires caseId", () => {
    expect(() =>
      TrafficEntrySchema.parse({ id: "t1", url: "http://x", method: "GET", createdAt: "now" }),
    ).toThrow();
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm vitest run packages/shared`
Expected: FAIL —— 模块 `./schemas.js` 不存在。

- [ ] **Step 5: 写 `packages/shared/src/schemas.ts`**

```ts
import { z } from "zod";

export const ScopeRuleSchema = z.object({
  caseId: z.string(),
  allowHosts: z.array(z.string()),
  denyHosts: z.array(z.string()).default([]),
});
export type ScopeRule = z.infer<typeof ScopeRuleSchema>;

export const CaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "paused", "archived"]).default("active"),
  scopeRules: z.array(ScopeRuleSchema),
  createdAt: z.string(),
});
export type Case = z.infer<typeof CaseSchema>;

export const TrafficEntrySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  url: z.string(),
  method: z.string(),
  requestHeaders: z.record(z.string()).default({}),
  responseStatus: z.number().nullable().default(null),
  responseBody: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type TrafficEntry = z.infer<typeof TrafficEntrySchema>;
```

- [ ] **Step 6: 写 `packages/shared/src/events.ts`**

```ts
import type { Case, TrafficEntry } from "./schemas.js";

export type RuntimeEvent =
  | { type: "case_created"; case: Case }
  | { type: "request_captured"; entry: TrafficEntry }
  | { type: "response_captured"; entry: TrafficEntry }
  | { type: "scope_violation"; caseId: string; url: string; reason: string };
```

- [ ] **Step 7: 写 `packages/shared/src/index.ts`**

```ts
export * from "./schemas.js";
export * from "./events.js";
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm vitest run packages/shared`
Expected: PASS（3 个 describe 全绿）。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(shared): add core Zod schemas and runtime events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Scope Guard 安全地基（阶段 0 核心）

**Files:**
- Create: `packages/tool-resolver/package.json`
- Create: `packages/tool-resolver/tsconfig.json`
- Create: `packages/tool-resolver/src/scope-guard.ts`
- Create: `packages/tool-resolver/src/index.ts`
- Test: `packages/tool-resolver/src/scope-guard.test.ts`

**Interfaces:**
- Consumes: `ScopeRule`（`@traceforge/shared`）。
- Produces:
  - `checkScope(url: string, rules: ScopeRule[]): { allowed: boolean; reason: string }`
  - 规则语义：host 命中任一 `denyHosts` → 拒绝；命中任一 `allowHosts`（精确或 `*.` 通配后缀）→ 允许；都不命中 → 拒绝（deny-by-default）。无效 URL → 拒绝。

- [ ] **Step 1: 写 `packages/tool-resolver/package.json`**

```json
{
  "name": "@traceforge/tool-resolver",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "@traceforge/shared": "workspace:*" }
}
```

- [ ] **Step 2: 写 `packages/tool-resolver/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: 写失败测试 `packages/tool-resolver/src/scope-guard.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { checkScope } from "./scope-guard.js";
import type { ScopeRule } from "@traceforge/shared";

const rules: ScopeRule[] = [
  { caseId: "c1", allowHosts: ["target.com", "*.target.com"], denyHosts: ["admin.target.com"] },
];

describe("checkScope", () => {
  it("allows an exact allowed host", () => {
    expect(checkScope("https://target.com/login", rules).allowed).toBe(true);
  });

  it("allows a wildcard subdomain", () => {
    expect(checkScope("https://api.target.com/v1", rules).allowed).toBe(true);
  });

  it("denies an explicitly denied host even if it matches a wildcard", () => {
    const r = checkScope("https://admin.target.com/", rules);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/denied/i);
  });

  it("denies an out-of-scope host (deny-by-default)", () => {
    expect(checkScope("https://evil.com/", rules).allowed).toBe(false);
  });

  it("denies an invalid URL", () => {
    expect(checkScope("not a url", rules).allowed).toBe(false);
  });

  it("denies when there are no rules", () => {
    expect(checkScope("https://target.com/", []).allowed).toBe(false);
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm vitest run packages/tool-resolver`
Expected: FAIL —— `checkScope` 未定义。

- [ ] **Step 5: 写 `packages/tool-resolver/src/scope-guard.ts`**

```ts
import type { ScopeRule } from "@traceforge/shared";

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".target.com"
    return host.endsWith(suffix) && host !== suffix.slice(1);
  }
  return host === pattern;
}

export function checkScope(
  url: string,
  rules: ScopeRule[],
): { allowed: boolean; reason: string } {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: "invalid URL" };
  }

  for (const rule of rules) {
    if (rule.denyHosts.some((p) => hostMatches(host, p))) {
      return { allowed: false, reason: `host ${host} is explicitly denied` };
    }
  }
  for (const rule of rules) {
    if (rule.allowHosts.some((p) => hostMatches(host, p))) {
      return { allowed: true, reason: `host ${host} is in scope` };
    }
  }
  return { allowed: false, reason: `host ${host} is out of scope (deny-by-default)` };
}
```

- [ ] **Step 6: 写 `packages/tool-resolver/src/index.ts`**

```ts
export { checkScope } from "./scope-guard.js";
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm vitest run packages/tool-resolver`
Expected: PASS（6 个用例全绿）。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(tool-resolver): add Scope Guard with deny-by-default and wildcard matching

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: server 包 —— SQLite schema 与 Case/Traffic 存储

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/stores/case-store.ts`
- Create: `apps/server/src/stores/traffic-store.ts`
- Test: `apps/server/src/stores/stores.test.ts`

**Interfaces:**
- Consumes: `Case`、`TrafficEntry`（`@traceforge/shared`）。
- Produces:
  - `createDb(path: string)`：返回 Drizzle 实例并建表（含 `cases`、`traffic_entries`，均带 `case_id`）。
  - `CaseStore`：`create(name, scopeRules) → Case`、`get(id) → Case | undefined`、`list() → Case[]`。
  - `TrafficStore`：`add(entry: TrafficEntry) → void`、`listByCase(caseId) → TrafficEntry[]`。
  - id 生成用 `crypto.randomUUID()` 加前缀（`case_`、`traf_`）。

- [ ] **Step 1: 写 `apps/server/package.json`**

```json
{
  "name": "@traceforge/server",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "node --import tsx --watch src/main.ts"
  },
  "dependencies": {
    "@traceforge/shared": "workspace:*",
    "@traceforge/tool-resolver": "workspace:*",
    "fastify": "^5.0.0",
    "@fastify/websocket": "^11.0.0",
    "@fastify/cors": "^10.0.0",
    "better-sqlite3": "^11.0.0",
    "drizzle-orm": "^0.38.0",
    "playwright": "^1.50.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

- [ ] **Step 2: 写 `apps/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: 安装依赖并下载 Playwright Chromium**

Run:
```bash
cd "E:/learn/TraceForge" && pnpm install && pnpm --filter @traceforge/server exec playwright install chromium
```
Expected: 依赖安装成功；Chromium 下载完成。

- [ ] **Step 4: 写 `apps/server/src/db/schema.ts`（Drizzle 表定义）**

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const cases = sqliteTable("cases", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  scopeRulesJson: text("scope_rules_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const trafficEntries = sqliteTable("traffic_entries", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  url: text("url").notNull(),
  method: text("method").notNull(),
  requestHeadersJson: text("request_headers_json").notNull(),
  responseStatus: integer("response_status"),
  responseBody: text("response_body"),
  createdAt: text("created_at").notNull(),
});
```

- [ ] **Step 5: 写 `apps/server/src/db/client.ts`**

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

export function createDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      scope_rules_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS traffic_entries (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, url TEXT NOT NULL, method TEXT NOT NULL,
      request_headers_json TEXT NOT NULL, response_status INTEGER, response_body TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_traffic_case ON traffic_entries(case_id);
  `);
  return drizzle(sqlite);
}

export type Db = ReturnType<typeof createDb>;
```

- [ ] **Step 6: 写失败测试 `apps/server/src/stores/stores.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client.js";
import { CaseStore } from "./case-store.js";
import { TrafficStore } from "./traffic-store.js";

let db: Db;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("CaseStore", () => {
  it("creates and retrieves a case with scope rules", () => {
    const store = new CaseStore(db);
    const c = store.create("demo", [{ caseId: "tmp", allowHosts: ["target.com"], denyHosts: [] }]);
    expect(c.id).toMatch(/^case_/);
    expect(c.status).toBe("active");
    const got = store.get(c.id);
    expect(got?.scopeRules[0].allowHosts).toEqual(["target.com"]);
  });
});

describe("TrafficStore", () => {
  it("adds and lists entries scoped by case", () => {
    const cases = new CaseStore(db);
    const c = cases.create("demo", []);
    const traffic = new TrafficStore(db);
    traffic.add({
      id: "traf_1", caseId: c.id, url: "https://target.com/a", method: "GET",
      requestHeaders: {}, responseStatus: 200, responseBody: "ok", createdAt: "now",
    });
    traffic.add({
      id: "traf_2", caseId: "other", url: "https://x/b", method: "GET",
      requestHeaders: {}, responseStatus: 200, responseBody: null, createdAt: "now",
    });
    const list = traffic.listByCase(c.id);
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe("https://target.com/a");
  });
});
```

- [ ] **Step 7: 运行测试确认失败**

Run: `pnpm vitest run apps/server`
Expected: FAIL —— store 模块不存在。

- [ ] **Step 8: 写 `apps/server/src/stores/case-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cases } from "../db/schema.js";
import { type Case, type ScopeRule, CaseSchema } from "@traceforge/shared";

export class CaseStore {
  constructor(private db: Db) {}

  create(name: string, scopeRules: ScopeRule[]): Case {
    const id = `case_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const c = CaseSchema.parse({ id, name, status: "active", scopeRules, createdAt });
    this.db.insert(cases).values({
      id, name, status: c.status,
      scopeRulesJson: JSON.stringify(scopeRules), createdAt,
    }).run();
    return c;
  }

  get(id: string): Case | undefined {
    const row = this.db.select().from(cases).where(eq(cases.id, id)).get();
    if (!row) return undefined;
    return CaseSchema.parse({
      id: row.id, name: row.name, status: row.status,
      scopeRules: JSON.parse(row.scopeRulesJson), createdAt: row.createdAt,
    });
  }

  list(): Case[] {
    return this.db.select().from(cases).all().map((row) =>
      CaseSchema.parse({
        id: row.id, name: row.name, status: row.status,
        scopeRules: JSON.parse(row.scopeRulesJson), createdAt: row.createdAt,
      }),
    );
  }
}
```

- [ ] **Step 9: 写 `apps/server/src/stores/traffic-store.ts`**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { trafficEntries } from "../db/schema.js";
import { type TrafficEntry, TrafficEntrySchema } from "@traceforge/shared";

export class TrafficStore {
  constructor(private db: Db) {}

  add(entry: TrafficEntry): void {
    const e = TrafficEntrySchema.parse(entry);
    this.db.insert(trafficEntries).values({
      id: e.id, caseId: e.caseId, url: e.url, method: e.method,
      requestHeadersJson: JSON.stringify(e.requestHeaders),
      responseStatus: e.responseStatus, responseBody: e.responseBody, createdAt: e.createdAt,
    }).run();
  }

  listByCase(caseId: string): TrafficEntry[] {
    return this.db.select().from(trafficEntries)
      .where(eq(trafficEntries.caseId, caseId)).all()
      .map((row) =>
        TrafficEntrySchema.parse({
          id: row.id, caseId: row.caseId, url: row.url, method: row.method,
          requestHeaders: JSON.parse(row.requestHeadersJson),
          responseStatus: row.responseStatus, responseBody: row.responseBody, createdAt: row.createdAt,
        }),
      );
  }
}
```

- [ ] **Step 10: 运行测试确认通过**

Run: `pnpm vitest run apps/server`
Expected: PASS（CaseStore + TrafficStore 全绿）。

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "feat(server): add SQLite schema and Case/Traffic stores with case_id isolation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: WebSocket 事件总线 + Fastify 路由

**Files:**
- Create: `apps/server/src/event-bus.ts`
- Create: `apps/server/src/routes.ts`
- Create: `apps/server/src/main.ts`
- Test: `apps/server/src/event-bus.test.ts`

**Interfaces:**
- Consumes: `RuntimeEvent`（`@traceforge/shared`）、`CaseStore`、`TrafficStore`（Task 4）、`checkScope`（Task 3）。
- Produces:
  - `EventBus`：`emit(event: RuntimeEvent)`、`subscribe(fn: (e: RuntimeEvent) => void): () => void`。
  - Fastify 应用：`POST /api/cases`（建 Case）、`GET /api/cases/:id/traffic`（列流量）、`POST /api/cases/:id/open`（经 Scope Guard 校验后用 Playwright 打开 URL 并捕获流量）、`GET /ws`（WebSocket 推 RuntimeEvent）。
  - `buildServer(db)`：返回配置好的 Fastify 实例（供测试注入内存 db）。

- [ ] **Step 1: 写失败测试 `apps/server/src/event-bus.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./event-bus.js";

describe("EventBus", () => {
  it("delivers emitted events to subscribers", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    bus.emit({ type: "scope_violation", caseId: "c1", url: "http://x", reason: "out of scope" });
    expect(fn).toHaveBeenCalledOnce();
    expect(fn.mock.calls[0][0].type).toBe("scope_violation");
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    off();
    bus.emit({ type: "scope_violation", caseId: "c1", url: "http://x", reason: "r" });
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run apps/server/src/event-bus.test.ts`
Expected: FAIL —— `EventBus` 未定义。

- [ ] **Step 3: 写 `apps/server/src/event-bus.ts`**

```ts
import type { RuntimeEvent } from "@traceforge/shared";

export class EventBus {
  private subs = new Set<(e: RuntimeEvent) => void>();

  emit(event: RuntimeEvent): void {
    for (const fn of this.subs) fn(event);
  }

  subscribe(fn: (e: RuntimeEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run apps/server/src/event-bus.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 `apps/server/src/routes.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { chromium } from "playwright";
import { checkScope } from "@traceforge/tool-resolver";
import type { Db } from "./db/client.js";
import { CaseStore } from "./stores/case-store.js";
import { TrafficStore } from "./stores/traffic-store.js";
import { EventBus } from "./event-bus.js";

export function registerRoutes(app: FastifyInstance, db: Db, bus: EventBus): void {
  const cases = new CaseStore(db);
  const traffic = new TrafficStore(db);

  app.post("/api/cases", async (req) => {
    const body = req.body as { name: string; allowHosts: string[]; denyHosts?: string[] };
    const c = cases.create(body.name, [
      { caseId: "pending", allowHosts: body.allowHosts, denyHosts: body.denyHosts ?? [] },
    ]);
    bus.emit({ type: "case_created", case: c });
    return c;
  });

  app.get("/api/cases", async () => cases.list());

  app.get("/api/cases/:id/traffic", async (req) => {
    const { id } = req.params as { id: string };
    return traffic.listByCase(id);
  });

  app.post("/api/cases/:id/open", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { url } = req.body as { url: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });

    const verdict = checkScope(url, c.scopeRules);
    if (!verdict.allowed) {
      bus.emit({ type: "scope_violation", caseId: id, url, reason: verdict.reason });
      return reply.code(403).send({ error: "out of scope", reason: verdict.reason });
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("response", async (res) => {
      const verdict = checkScope(res.url(), c.scopeRules);
      if (!verdict.allowed) return; // 不捕获越界资源
      const entry = {
        id: `traf_${randomUUID()}`, caseId: id, url: res.url(),
        method: res.request().method(), requestHeaders: res.request().headers(),
        responseStatus: res.status(),
        responseBody: null as string | null,
        createdAt: new Date().toISOString(),
      };
      traffic.add(entry);
      bus.emit({ type: "response_captured", entry });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await browser.close();
    return { ok: true };
  });
}
```

- [ ] **Step 6: 写 `apps/server/src/main.ts`**

```ts
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";

export async function buildServer(dbPath = "traceforge.sqlite") {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const db = createDb(dbPath);
  const bus = new EventBus();
  registerRoutes(app, db, bus);

  app.get("/ws", { websocket: true }, (socket) => {
    const off = bus.subscribe((e) => socket.send(JSON.stringify(e)));
    socket.on("close", off);
  });

  return app;
}

// 直接运行时启动
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  await app.listen({ port: 4000, host: "127.0.0.1" });
}
```

- [ ] **Step 7: 手动冒烟测试服务端**

Run（后台启动后用 curl 验证）:
```bash
cd "E:/learn/TraceForge" && (node --import tsx apps/server/src/main.ts &) && sleep 3 && \
curl -s -X POST localhost:4000/api/cases -H 'content-type: application/json' \
  -d '{"name":"demo","allowHosts":["example.com"]}'
```
Expected: 返回含 `"id":"case_..."`、`"status":"active"` 的 JSON。记下 case id 后验证越界拦截：
```bash
curl -s -X POST localhost:4000/api/cases/<CASE_ID>/open -H 'content-type: application/json' \
  -d '{"url":"https://evil.com/"}'
```
Expected: HTTP 403，body 含 `"error":"out of scope"`。随后用范围内 URL 验证捕获：
```bash
curl -s -X POST localhost:4000/api/cases/<CASE_ID>/open -H 'content-type: application/json' \
  -d '{"url":"https://example.com/"}'
curl -s localhost:4000/api/cases/<CASE_ID>/traffic
```
Expected: 第二个 curl 返回非空数组，含 example.com 的请求记录。完成后 `kill %1` 或结束后台进程。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(server): add event bus, Fastify routes, and scope-gated traffic capture

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: web 前端 —— Case 创建与 Traffic Panel

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/store.ts`
- Create: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: 后端 REST（`/api/cases`、`/api/cases/:id/open`、`/api/cases/:id/traffic`）与 WebSocket（`/ws`）、`TrafficEntry`/`RuntimeEvent` 类型（`@traceforge/shared`）。
- Produces: 可在浏览器交互的最小工作台：建 Case → 输入 URL 打开 → Traffic Panel 经 WebSocket 实时追加请求行。

- [ ] **Step 1: 写 `apps/web/package.json`**

```json
{
  "name": "@traceforge/web",
  "version": "0.1.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": {
    "@traceforge/shared": "workspace:*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

- [ ] **Step 2: 写 `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM"], "noEmit": true },
  "include": ["src"]
}
```

- [ ] **Step 3: 写 `apps/web/vite.config.ts`（代理后端）**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4000",
      "/ws": { target: "ws://127.0.0.1:4000", ws: true },
    },
  },
});
```

- [ ] **Step 4: 写 `apps/web/index.html`**

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>TraceForge</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 写 `apps/web/src/api.ts`**

```ts
import type { Case, TrafficEntry } from "@traceforge/shared";

export async function createCase(name: string, allowHosts: string[]): Promise<Case> {
  const r = await fetch("/api/cases", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, allowHosts }),
  });
  return r.json();
}

export async function openUrl(caseId: string, url: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/open`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export async function listTraffic(caseId: string): Promise<TrafficEntry[]> {
  const r = await fetch(`/api/cases/${caseId}/traffic`);
  return r.json();
}
```

- [ ] **Step 6: 写 `apps/web/src/store.ts`**

```ts
import { create } from "zustand";
import type { TrafficEntry, RuntimeEvent } from "@traceforge/shared";

interface State {
  caseId: string | null;
  traffic: TrafficEntry[];
  setCase: (id: string) => void;
  addEntry: (e: TrafficEntry) => void;
  connectWs: () => void;
}

export const useStore = create<State>((set, get) => ({
  caseId: null,
  traffic: [],
  setCase: (id) => set({ caseId: id, traffic: [] }),
  addEntry: (e) => set((s) => ({ traffic: [...s.traffic, e] })),
  connectWs: () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as RuntimeEvent;
      if (event.type === "response_captured" && event.entry.caseId === get().caseId) {
        get().addEntry(event.entry);
      }
    };
  },
}));
```

- [ ] **Step 7: 写 `apps/web/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useStore } from "./store.js";
import { createCase, openUrl } from "./api.js";

export function App() {
  const { caseId, traffic, setCase, connectWs } = useStore();
  const [name, setName] = useState("demo");
  const [hosts, setHosts] = useState("example.com");
  const [url, setUrl] = useState("https://example.com/");

  useEffect(() => { connectWs(); }, [connectWs]);

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>TraceForge</h1>
      {!caseId ? (
        <div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="case name" />
          <input value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="allow hosts (comma)" />
          <button onClick={async () => {
            const c = await createCase(name, hosts.split(",").map((h) => h.trim()));
            setCase(c.id);
          }}>Create Case</button>
        </div>
      ) : (
        <div>
          <p>Case: {caseId}</p>
          <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 360 }} />
          <button onClick={() => openUrl(caseId, url)}>Open</button>
          <h2>Traffic ({traffic.length})</h2>
          <table border={1} cellPadding={4}>
            <thead><tr><th>Method</th><th>Status</th><th>URL</th></tr></thead>
            <tbody>
              {traffic.map((t) => (
                <tr key={t.id}><td>{t.method}</td><td>{t.responseStatus}</td><td>{t.url}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: 写 `apps/web/src/main.tsx`**

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 9: 安装依赖并验证前端构建**

Run:
```bash
cd "E:/learn/TraceForge" && pnpm install && pnpm --filter @traceforge/web build
```
Expected: Vite 构建成功，输出 `dist/`。

- [ ] **Step 10: 端到端手动验证**

Run（两个终端）:
```bash
# 终端 1
cd "E:/learn/TraceForge" && pnpm dev:server
# 终端 2
cd "E:/learn/TraceForge" && pnpm dev:web
```
在浏览器打开 `http://localhost:5173`，依次：建 Case（allow host `example.com`）→ Open `https://example.com/` → 观察 Traffic 表格出现 example.com 的请求行。再尝试 Open `https://evil.com/` → 表格不应新增行（越界被拦）。
Expected: 范围内 URL 流量实时出现；越界 URL 无流量。

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "feat(web): add Case creation and live Traffic Panel via WebSocket

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: 阶段收尾 —— 全量校验与 README

**Files:**
- Create: `README.md`
- Modify: 无（仅验证）

**Interfaces:**
- Consumes: 全部前序任务产物。
- Produces: 可读的启动说明 + 一次全绿的 `pnpm test`。

- [ ] **Step 1: 全量测试**

Run: `cd "E:/learn/TraceForge" && pnpm test`
Expected: PASS —— shared（3）、tool-resolver（6）、server（store + event-bus）全绿。

- [ ] **Step 2: 全量构建**

Run: `cd "E:/learn/TraceForge" && pnpm -r build`
Expected: 各包 `tsc` / `vite build` 均无错误。

- [ ] **Step 3: 写 `README.md`**

```markdown
# TraceForge

证据驱动的人机协同红队推理工作台。详见 [设计文档](TraceForge_design.md)。

## 开发启动

\`\`\`bash
pnpm install
pnpm --filter @traceforge/server exec playwright install chromium
pnpm dev:server   # 后端 :4000
pnpm dev:web      # 前端 :5173
\`\`\`

## 当前进度（阶段 0 + 1）

- pnpm monorepo 骨架
- Scope Guard 安全地基（deny-by-default，单元测试覆盖）
- SQLite 存储（Case / Traffic，case_id 隔离）
- WebSocket 事件总线
- Playwright 抓包 + 实时 Traffic Panel

## 测试

\`\`\`bash
pnpm test
\`\`\`
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: add README with phase 0-1 setup and progress

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：本计划对应设计文档第 21 章「阶段 0：安全与上下文地基」中的 ScopeGuard 子项 + 「阶段 1：工作台骨架」全部交付物（BrowserPanel 的最小形态=open URL，TrafficPanel，CaseManager，WebSocket Event Bus，SQLite 初始化）。上下文管理、SecretStore、命令分级等阶段 0 其余子项不在本计划范围，留待后续计划（它们服务于尚未引入的 AI / 终端能力）。
- **类型一致性**：`ScopeRule` / `Case` / `TrafficEntry` / `RuntimeEvent` 全部单源定义于 `@traceforge/shared`，server 与 web 均消费同一份；`checkScope` 签名在 Task 3 定义、Task 5 消费，一致。
- **AI Provider**：按用户决定第一版接 Anthropic（`claude-opus-4-8`），但本阶段无 LLM 调用，故仅在 Global Constraints 记录、不建空抽象（YAGNI），待阶段 3「AI 事实提取」计划再落地 provider。
