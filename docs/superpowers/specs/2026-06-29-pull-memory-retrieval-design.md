# Pull 式记忆检索（Memory Retrieval Tools）设计

> 状态：设计已确认，待写实现计划。
> 背景：认知内核（2026-06-26）用 push 式 ContextBuilder 替 LLM 预塑 Fact（relevanceScore 打分 topK）。本设计把 Fact 预塑改为 pull 式——给 agent 检索工具自己拉，向 Claude Code/Codex 的「系统提示轻量 + 工具按需拉取」形态靠拢。
> 最高原则：第 3.0 节「LLM 主导、零硬编码」——检索决策权交还 LLM，去掉代码替 LLM 猜相关性的 relevanceScore 预塑。

## 1. 背景与问题

当前 `routes.ts` agent/run 前调 `buildContext({ facts: factStore.listByCase(id), ... })`，ContextBuilder 内部 `topK(facts, focus, 12)` 用 `relevanceScore`（packages/reasoning-core/src/relevance.ts）替 LLM 猜 12 个相关 Fact 塞进 Layer2。

问题：
- **替 LLM 猜，违背零硬编码**：relevanceScore 是写死的规则（同 host +3、bigram×0.5、新鲜度 2−0.1×天）。LLM 比这套规则强，却被剥夺了检索决策权。
- **漏关键 Fact**：relevanceScore 只搜 fact 的 `type+title`（relevance.ts:21）。goal「测越权」与 fact「login_endpoint /api/login」字面不重叠 → bigram 命中 0 → 关键 fact 排不进前 12 被丢。
- **搜不到 value 里的细节**：value（可能含越权线索、源码片段）从不参与检索。
- **token 浪费**：每次塞 12 个 Fact，不管 agent 这轮用不用得到。
- **无法深入**：只有摘要进 context，agent 想看某 Fact 完整 value 做不到。

## 2. 整体架构

从「ContextBuilder 替 LLM 预塑 Fact」（push）→「agent 用工具自己拉」（pull）。混合式：Layer1 轻量确定性上下文仍 push，Layer2 的 Fact 预塑改 pull。

**改造点（3 处）：**

1. **ContextBuilder 瘦身**（改 packages/reasoning-core/src/context-builder.ts）
   - 保留 Layer1 焦点（会话状态/近期对话/活跃任务/scope）。
   - 删除 Layer2 的 Fact 预塑（topK + relevanceScore 调用）；Layer2 仅保留活跃 hypotheses。
   - Layer1 新增「资源清单」行：告知 agent 现有多少 Fact/流量/远期摘要 + 提示用检索工具。
   - 入参 `facts: Fact[]` 改为 `factCount: number`（不再传整个数组）。
   - Layer3 远期摘要保留。

2. **4 个检索工具**（新建 packages/extension/src/memory-tools.ts）
   - search_facts / get_fact_detail / search_traffic / recall_conversation。
   - 全部 risk=normal，复用现有 store 方法，零新增 store 方法。

3. **关键词打分纯函数**（新建 packages/reasoning-core/src/keyword-search.ts）
   - 从 relevance.ts 的 bigram 逻辑抽出 `keywordScore(query, text): number`，4 工具共用。
   - 预留接口，日后换向量检索（embeddingSimilarity）工具不动。

**relevanceScore.ts 不删**：其 ContextBuilder 预塑用途移除后，保留作为升级接口锚点 / 资源清单可选排序，标注不再用于预塑。

**数据流变化：**
```
旧 push: run 前 topK(facts, focus, 12) 猜 12 个 Fact 塞 Layer2
新 pull: run 前 Layer1 只报「有 N 个 Fact 可查」
         → agent 推理中自调 search_facts("登录 越权")
         → 后端 keywordScore 匹配 type+title+value+tags 返回命中摘要
         → agent 再 get_fact_detail(id) 看完整 value
```

## 3. 公共打分：keyword-search.ts

```ts
// query 与 text 都做 bigram，命中数即分。支持中文连续串。单字 query 直接 includes。
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
升级路径：换向量时，把本函数替换为 embedding 相似度，4 工具调用方不变（预留 RetrievalStrategy，与 §25 一致）。

## 4. 四个检索工具（memory-tools.ts）

工具模式照现有 case-tools.ts：`make<Name>Tool(caseId, reader): ToolDescriptor`，写操作走注入接口便于单测。ToolDescriptor 形状见 packages/extension/src/tool.ts。

### 4.1 search_facts(query, limit?=10)
- 注入接口：`FactSearchReader { listByCase(caseId): Fact[] }`（复用 FactStore.listByCase）
- 搜索字段：`type + title + JSON.stringify(value) + tags.join(" ")`
- 打分排序：`keywordScore(query, 字段拼接)` > 0，降序取 limit
- 返回（摘要，不含 value）：每行 `id [type] title`，末尾附 `（用 get_fact_detail(id) 看完整内容）`
- 空命中：`ok:true`，content = `没有匹配"query"的 Fact`

### 4.2 get_fact_detail(id)
- 注入接口：`FactDetailReader { getById(id): Fact | undefined }`（复用 FactStore.getById）
- 返回：完整 `JSON.stringify({ type, title, value, source, confidence, tags, validity }, null, 2)`
- id 不存在：`ok:false`，content = `未找到 Fact id`

### 4.3 search_traffic(query, limit?=10)
- 注入接口：`TrafficSearchReader { listByCase(caseId): TrafficEntry[] }`（复用 TrafficStore.listByCase）
- 搜索字段：`url + method + String(responseStatus)`
- 返回：每行 `id method status url`（对照 list_traffic 格式），末尾附 `（用 get_traffic(id) 看 headers/body）`
- 空命中：`ok:true` + 提示

### 4.4 recall_conversation(query, limit?=10)
- 注入接口：`ConvoSearchReader { listByCase(caseId): AgentEvent[] }` + `SummaryReader { latest(caseId): { content: string } | undefined }`
- 搜索范围：agent_events 的 user/text/done 三类的 `text` + 最新远期摘要的 content
- 打分：对每条 event.text 算 keywordScore，对 summary.content 整体算一次
- 返回：命中的 `[kind] text 片段（截断 ~120 字）`，若 summary 命中附 `远期摘要相关段：...`
- 空命中：`ok:true` + 提示

### 4.5 工具结果带「下一步提示」
每个工具 content 末尾引导 agent 深入（如 search_facts → get_fact_detail）。这是 pull 式自我延续的关键：结果本身告诉 agent 下一步能做什么。

## 5. ContextBuilder 改造（context-builder.ts）

- ContextInput：`facts: Fact[]` → `factCount: number`；新增 `trafficCount: number`、`summaryCount: number`。
- 删除 `buildLayer2` 中的 `topK(input.facts, focus, kk)` 及 protectedFactIds 注入逻辑（pull 式下 protected 不再适用于预塑——agent 自己会搜到引用的 fact）。Layer2 仅保留活跃 hypotheses。
- Layer1 新增资源清单行：
  ```
  📁 本 Case 已积累：${factCount} 个 Fact、${trafficCount} 条流量、${summaryCount} 条远期对话摘要。
  需要历史发现时用 search_facts("关键词") / search_traffic(...) / recall_conversation(...) 检索；要某 Fact 细节用 get_fact_detail(id)。
  ```
- 降级逻辑保留（Layer3 砍 / 截断），但因 Layer2 不再有大量 Fact，触发更少。
- BuildResult 的 `injectedFactIds` 保留字段但恒为空数组 `[]`（不再预塑 Fact；保留字段避免破坏 routes.ts 的 context_built timeline 审计行）；estimatedTokens/degraded 不变。

## 6. 接线（routes.ts）

agent/run 中：
- 注册 4 工具（与现有认知工具并排）：
  ```ts
  registry.register(makeSearchFactsTool(id, factStore));
  registry.register(makeGetFactDetailTool(id, factStore));
  registry.register(makeSearchTrafficTool(id, traffic));
  registry.register(makeRecallConversationTool(id, agentEventStore, contextSummaryStore));
  ```
- buildContext 调用改：传 `factCount: factStore.listByCase(id).length`、`trafficCount: traffic.listByCase(id).length`、`summaryCount`（contextSummaryStore 有 latest，可用是否存在折算 0/1，或后续加 countByCase；第一版 summaryCount 用 latest 存在与否 → 0 或 1）。不再传 facts 数组。
- 移除 `protectedFactIds`/`evidenceRefIds` 的预塑相关计算（若仅服务于 buildContext）。

## 7. 容错（降级不崩）

```
· 检索无命中            → ok:true + "没有匹配" 提示（空结果是正常信息，非 error）
· get_fact_detail 不存在 → ok:false + "未找到"（对照 get_traffic）
· 资源清单 count 出错    → Layer1 其余照常，agent 仍能跑
· 任何工具 execute 抛错  → 返回 ok:false + 错误信息，不中断 run
```

## 8. 测试（TDD，vitest，注入 mock）

| 单元 | 测什么 |
|---|---|
| keyword-search.ts | 单字 includes、多字 bigram 命中计数、中文连续串、无命中返 0、空输入返 0 |
| memory-tools.ts | search_facts 命中排序+能搜到 value 里的词、get_fact_detail 存在/不存在、search_traffic 按 url 命中、recall_conversation 搜 events+summary、空结果 ok:true |
| context-builder.ts（改） | Layer2 不再含预塑 Fact、资源清单行含正确 count、入参改 factCount 后既有降级测试仍过 |
| 集成 routes-cognitive.test.ts（加） | agent 调 search_facts 能拿到已记录的 Fact（端到端 pull 生效） |

## 9. 实现分期（A→D，各自独立 TDD）

```
A. keyword-search.ts 公共纯函数（地基）
B. memory-tools.ts 4 工具 + 注入接口（依赖 A）
C. ContextBuilder 瘦身（删 Layer2 Fact 预塑 + 资源清单 + 入参改 count）
D. 接线 routes.ts：注册 4 工具 + 改 buildContext 调用
```
D 完成时 pull 式端到端生效：agent 不再被预塑 Fact 喂，而是自己 search。

## 10. 非目标（YAGNI）

- 不引入向量/embedding 语义检索（留 keywordScore→embedding 升级接口）。第一版关键词检索：agent 搜「越权」搜不到字面「IDOR」的 fact（语义差距），靠 agent 多次换词缓解。向量语义是下一个独立迭代。
- 不删 relevanceScore.ts（保留作升级锚点）。
- 不改 SessionState / Hypothesis / Compressor / 3 认知工具（认知内核其余全保留）。
- 不动前端（检索是 agent 内部行为，工具调用已在事件流展示）。
