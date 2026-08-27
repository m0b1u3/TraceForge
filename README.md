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
- Web 黑盒 HTTP 通过 Execution Node 的授权网络 Broker 执行并生成持久化回执；Browser Worker 在受控代理后端完成前保持关闭，不允许直连回退。

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

当前基线（2026-08-27）：146 个快速测试文件、559 项测试通过，全工作区构建通过。

第三方 Tool Provider 默认不受信任。部署者需要将 Ed25519 公钥写入
`config/tool-provider-trust-roots.json`（格式参见同目录示例），签名和包内可执行文件
及完整包 SHA-256 均通过后，Provider 才会被原子复制到只读托管目录并形成持久化安装记录。
Manifest 使用包内相对入口并签署静态工具目录；控制面会拒绝路径/符号链接逃逸、包变更和
运行时身份不一致。默认生产来源按每次工具调用的真实 Run/Work 归属通过 Execution Node 启动，
不会回退到全局常驻或非沙箱进程。版本切换会先停止旧版本接收新调用，原子记录新版本
`enabled` 与旧版本 `draining`，等待旧调用完成后再关闭旧来源；重启会确定性收敛中断的排空状态。

## 架构文档

- [Scenario Control Plane API](docs/scenario-control-plane-api.md)
- [Security Execution Model](docs/security-execution-model.md)
- [当前开发进度与生产化计划](docs/development-status-and-roadmap.md)

## 项目约束

- 具体攻击或分析手段属于 Scenario Profile、Worker 或工具插件，不进入底座调度逻辑。
- 单一信号不能验证安全发现；结论必须具备可追溯证据链、可复现因果机制和明确影响。
- 同一 Run 可保留多个独立假设和排队任务，但一次只执行一个验证任务。
- 凭据可作为受权限控制的黑板实体供使用者查看和 Worker 使用，其访问与使用必须进入审计事件。
