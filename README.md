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

## 当前进度（阶段 0 + 1）

- pnpm monorepo 骨架
- Scope Guard 安全地基（deny-by-default + 通配符，单元测试覆盖）
- SQLite 存储（Case / Traffic，case_id 隔离）
- WebSocket 事件总线
- Playwright 抓包 + 实时 Traffic Panel

## 测试

```bash
pnpm test     # 14 个单元测试
pnpm -r build # 全量构建
```
