# Agent Harness 与 Worker Host 边界

更新日期：2026-09-01

## 目的

通用安全智能体的“思考循环”不能依赖 Fastify、SQLite、Web 黑盒包或某一种执行节点；工作租约、宿主心跳和故障恢复也不应混入模型与 Observer 的认知顺序。

当前边界分为两层：

- `@traceforge/agent-runtime` 提供 `AgentHarness/AgentSession`，负责回合预算、取消检查，“模型产生 Intent、持久化可审计 Intent、Observer 审查”的固定阶段顺序，以及工具 Intent 去重/可用性判定、工具 Observation 的审批/失败/成功策略和连续失败终止信号。
- `@traceforge/worker-runtime` 提供 `WorkerHost`，负责 Worker 注册、心跳、Work 领取、租约续期、所有权撤销、checkpoint 恢复和控制面终态提交。它把每一个认知回合交给 Agent Session，并在受治理工具执行前后保存精确恢复状态。

租约时代的 `LeaseWorkerRuntime/LeaseWorkerOptions` 公开名称已经删除；生产装配、测试和文档统一使用 `WorkerHost/WorkerHostOptions`。

## Scenario 装配

`@traceforge/scenario-sdk` 不再声明 Cookie、Session、Traffic、HTTP、Browser 或原始 `ExecutionNode`。通用宿主上下文只提供：

- 通用授权与证据端口；
- 按 Scenario Package 精确版本绑定的通用 Artifact 与 compare-and-set State 端口；
- 按版本化字符串标识解析的不透明 `ScenarioHostCapabilities`；
- 调用期、宿主创建的 `GovernedExecutionPort`。

具体场景自己声明能力接口和能力 ID。Web 黑盒包目前声明 Session 与 Traffic 两项能力，产品入口安装 Web 包时显式绑定 SQLite Adapter；不安装该包的底座宿主不会创建或装配这些端口。场景只能向 Governed Execution 提交操作参数，不能提供 attribution、权限快照或直接持有原始 Execution Node。

## 强制不变量

1. Scenario 提议能力调用，Harness/Host 决定是否以及如何执行。
2. Agent Runtime 不得 import Worker Runtime、Server、Execution Node 或具体 Scenario。
3. Scenario SDK 不得重新出现 Web/transport 专用宿主 Contract。
4. Foundation 边界扫描必须自动覆盖新 package、拒绝反向依赖和 workspace 环。
5. 框架级集成宿主必须在不依赖 Server、SQLite 或任何 Scenario 包的情况下完成一个有证据引用的 Work。
6. Artifact/State 的调用归属必须由 Registry 固定到接收端的 Package id/version；跨包或跨版本访问必须在 Store 前拒绝。
7. Artifact 必须保存摘要、引用、SHA-256、大小和有界元数据；State 必须使用有界 JSON、revision compare-and-set 与可重放命令结果，数据库重启后不能丢失。

## 尚未完成

这次切分没有实现 Browser、网络扫描、代码审计或其他场景功能。受控工具的真实副作用、精确 pending receipt/checkpoint 持久化和控制面终态提交仍属于 `WorkerHost` 的宿主责任；Agent Runtime 只拥有与领域无关的认知顺序和 Observation 决策策略，不应直接依赖 SQLite 或控制面。

下一批迁移面是通用 Agent Execution Journal：把当前 Worker checkpoint 中的认知状态、Intent/Observation 记录和终止原因整理为 Agent Runtime 定义的版本化协议，再由 WorkerHost Adapter 负责持久化和提交。目标是让框架级 Harness 在更换宿主存储后仍能从同一份 Agent Journal 恢复，而不是把租约、数据库或具体场景塞进 Agent Runtime。
