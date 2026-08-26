# TraceForge

TraceForge 是独立运行的通用安全智能体底座。它以 Scenario Control Plane、共享黑板、结构化证据、弹性 Worker、模型执行与安全门禁为核心，不依赖 Codex，也不围绕某个漏洞、工具或目标写死产品逻辑。

当前代码只保留新的 Scenario 运行链路：

- Scenario Profile 定义目标、阶段、能力需求和授权边界。
- Planner、Observer 与 Worker 通过结构化 Work、Fact、Hypothesis、Evidence 和事件协作。
- Worker Runtime 提供租约、心跳、重试、取消、恢复和能力路由。
- Model Runtime 提供模型准入、路由、预算、调用审计和结构化输出。
- Scenario Agent Protocol 持久化 turn/item 生命周期，支持游标重放和 WebSocket 增量同步。
- Evidence Graph、执行会话网关、审批门禁和认知上下文快照为不同安全场景提供统一底座。
- Execution Node 对每次进程执行强制绑定 CPU、内存、进程数量和写入 I/O 配额，并将配额证明写入执行回执。
- Web 黑盒能力通过原生 HTTP、受控 Browser Worker、流量/证据存储及按需 MCP 工具装配。

旧聊天式 `AgentRun`/`AgentEvent` 运行时、旧 Solver、旧 BrowserSession 和 Burp 桥接已经删除，不提供兼容层。数据库启动时会直接丢弃它们对应的旧表。

## 开发启动

```bash
pnpm install
pnpm dev:server
pnpm dev:web
```

默认地址：后端 `127.0.0.1:4000`，前端 `127.0.0.1:5173`。TraceForge 未配置 LLM 或 MCP 时仍可启动；需要执行模型任务时再通过设置界面或 `config/llm.json` 配置 Provider。

## 验证

```bash
pnpm test:fast
pnpm build
```

当前基线（2026-08-26）：137 个测试文件、509 项测试通过，全工作区构建通过。

## 架构文档

- [Scenario Control Plane API](docs/scenario-control-plane-api.md)
- [Security Execution Model](docs/security-execution-model.md)

## 项目约束

- 具体攻击或分析手段属于 Scenario Profile、Worker 或工具插件，不进入底座调度逻辑。
- 单一信号不能验证安全发现；结论必须具备可追溯证据链、可复现因果机制和明确影响。
- 同一 Run 可保留多个独立假设和排队任务，但一次只执行一个验证任务。
- 凭据可作为受权限控制的黑板实体供使用者查看和 Worker 使用，其访问与使用必须进入审计事件。
