# TraceForge

证据驱动的人机协同红队推理工作台。详见 [设计文档](TraceForge_design.md)。

## 开发启动

```bash
pnpm install
pnpm --filter @traceforge/server exec playwright install chromium
pnpm dev:server   # 后端 :4000
pnpm dev:web      # 前端 :5173
```

打开 `http://localhost:5173`：创建 Case（指定 allow hosts）→ 输入范围内 URL 点击 Open → Traffic Panel 经 WebSocket 实时显示捕获的请求。越界 URL 会被 Scope Guard 拦截（403），不产生流量。

## 配置 LLM（可选，启用 AI 提取）

拷贝模板并按需修改 provider/model/baseUrl，再设置对应 API key 环境变量：

```bash
cp config/llm.example.json config/llm.json
# DeepSeek（OpenAI 兼容）示例：
export DEEPSEEK_API_KEY=sk-...
# 或 Anthropic：把 config/llm.json 改为 anthropic provider，并
export ANTHROPIC_API_KEY=sk-ant-...
```

`config/llm.json` 不纳入版本控制；未配置时 AI 提取返回空候选（其余功能不受影响）。

## 当前进度（阶段 0 + 1 + 2 + 3 + 4）

- pnpm monorepo 骨架
- Scope Guard 安全地基（deny-by-default + 通配符，单元测试覆盖）
- SQLite 存储（Case / Traffic / Fact / Task / Timeline / ActionCard / Decision，case_id 隔离）
- WebSocket 事件总线
- Playwright 抓包 + 实时 Traffic Panel
- Facts / Tasks / Timeline：手动标记请求为 Fact、创建挂起（blocked）Task、Timeline 实时回放
- AI 事实提取：从流量提取候选 Fact（带 prompt injection 数据边界防护），人工 confirm/reject 后入库。LLM 多 Provider 可配置（Anthropic / OpenAI 兼容，后者覆盖 DeepSeek 等），模型与 baseURL 由 config/llm.json 决定
- Action Card：AI 基于已确认 Facts 生成候选动作（每个动作必须引用至少一个 fact_id，无证据依据的动作被拒），人工 approve/reject，批准时记录 Decision；本阶段只生成+决策，不执行

## 测试

```bash
pnpm test     # 63 个单元测试
pnpm -r build # 全量构建
```
