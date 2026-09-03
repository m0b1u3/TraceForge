# Agent Harness 与 Worker Host 边界

更新日期：2026-09-02

## 目的

通用安全智能体的“思考循环”不能依赖 Fastify、SQLite、Web 黑盒包或某一种执行节点；工作租约、宿主心跳和故障恢复也不应混入模型与 Observer 的认知顺序。

当前边界分为两层：

- `@traceforge/agent-runtime` 提供 `AgentHarness/AgentSession`，负责回合预算、取消检查，“模型产生 Intent、持久化可审计 Intent、Observer 审查”的固定阶段顺序，以及工具 Intent 去重/可用性判定、工具 Observation 的审批/失败/成功策略和连续失败终止信号。
- `@traceforge/agent-runtime` 同时定义 `traceforge-agent-execution-journal@1`：只保存宿主无关的回合、Intent/Observation 条目、纠偏、连续失败、已提交 Intent 和终态原因，并施加条目/引用/正文容量上限。
- `@traceforge/worker-runtime` 提供 `WorkerHost` 和 `AgentJournalCheckpointAdapter`，负责 Worker 注册、心跳、Work 领取、租约续期、所有权撤销、checkpoint 恢复和控制面终态提交。v3 Host Checkpoint 只把 Agent Journal 与 pending Invocation、pending Control command、租约和 Work 归属对齐。

租约时代的 `LeaseWorkerRuntime/LeaseWorkerOptions` 公开名称已经删除；生产装配、测试和文档统一使用 `WorkerHost/WorkerHostOptions`。

## Scenario 装配

`@traceforge/scenario-sdk` 不再声明 Cookie、Session、Traffic、HTTP、Browser 或原始 `ExecutionNode`。通用宿主上下文只提供：

- 通用授权与证据端口；
- 按 Scenario Package 精确版本绑定的通用 Artifact 与 compare-and-set State 端口；
- 按版本化字符串标识解析的不透明 `ScenarioHostCapabilities`；
- 调用期、宿主创建的 `GovernedExecutionPort`。

具体场景自己声明能力接口和能力 ID。Web 黑盒包目前声明 Session 与 Traffic 两项能力，产品入口安装 Web 包时显式绑定 SQLite Adapter；不安装该包的底座宿主不会创建或装配这些端口。场景只能向 Governed Execution 提交操作参数，不能提供 attribution、权限快照或直接持有原始 Execution Node。

Scenario Package 合同仍能表达两种执行形态，但生产组合只接受 `traceforge-scenario-process-rpc@1` 进程声明；旧同进程工厂仅供显式测试/迁移兼容。进程声明只包含包入口身份和允许的工具/宿主能力；可执行路径、环境和沙箱证明由可信宿主另行装配，包不能给自己签发启动权限。进程形态不会收到 `ScenarioToolHostContext`，只能通过 Package Capability Broker 使用授权、证据、Artifact 和 State RPC。

## 强制不变量

1. Scenario 提议能力调用，Harness/Host 决定是否以及如何执行。
2. Agent Runtime 不得 import Worker Runtime、Server、Execution Node 或具体 Scenario。
3. Scenario SDK 不得重新出现 Web/transport 专用宿主 Contract。
4. Foundation 边界扫描必须自动覆盖新 package、拒绝反向依赖和 workspace 环。
5. 框架级集成宿主必须在不依赖 Server、SQLite 或任何 Scenario 包的情况下完成一个有证据引用的 Work。
6. Artifact/State 的调用归属必须由 Registry 固定到接收端的 Package id/version；跨包或跨版本访问必须在 Store 前拒绝。
7. Artifact 必须保存摘要、引用、SHA-256、大小和有界元数据；State 必须使用有界 JSON、revision compare-and-set 与可重放命令结果，数据库重启后不能丢失。
8. v3 Host Checkpoint 不得再复制 v1/v2 的顶层认知字段；发现 Journal 与旧字段并存必须按歧义损坏拒绝。
9. 完成/阻断命令必须先作为 pending Control command 与 Agent 终态一起落盘，再向控制面提交；同租约重启只重放原命令，跨租约完成命令不得自动重放。
10. Scenario Process 必须协商专用协议 Profile，并同时匹配 Package id/version、source、工具版本和声明能力；普通 Provider 进程不能冒充 Scenario Process。
11. 反向能力调用的 Case/Run/Work/Worker/lease 归属只能来自仍存活的父工具请求；子进程提供这些字段、请求未声明能力、旧进程代次或过期租约必须拒绝。
12. Package 撤销必须终止当前进程与在途能力，进程工具调用必须进入 Foundation 共享并发调度；崩溃重启不得越过代次和重启预算。

## Agent Journal 与恢复

旧 v1/v2 checkpoint 在 Host Adapter 内单向升级为 v3，随后保存时不再携带旧认知字段。稳定 Session 身份只由 Run/Work 构成，不绑定 Worker、lease、SQLite 或文件系统，因此更换 Worker Host 和 checkpoint Store 后仍可读同一份 Journal。框架级测试已覆盖内存 Store 序列化搬迁和 Host 替换；生产测试覆盖终态 checkpoint 已提交、控制面尚未收到时的真实 SIGKILL，重启后模型调用为零、工具副作用不重复。

受控工具的真实副作用、pending receipt、pending Control command 和控制面提交仍属于 `WorkerHost`，Agent Runtime 不依赖 SQLite、控制面或某个执行节点。显式重新租赁可以恢复旧 blocked Journal，但 completed 终态跨租约一律关闭，防止把已完成动作当成新任务重跑。

## 尚未完成

这次切分没有实现 Browser、网络扫描、代码审计或其他场景功能，也没有迁移现有 Web 黑盒应用包；生产底座不会再执行它的旧同进程工具工厂。Scenario Process 已接持久监督账本、OS-backed Execution Node、运行期撤销、共享容量和强杀恢复，但平台隔离强度仍以 Linux/Windows 原生实机验收为准。

下一底座批次是把 Package 授权解析、Output Schema 校验和 Evidence Mapping 从宿主 JavaScript 回调改成声明式数据合同。完成前，这些回调仍只能作为可信宿主编译代码，不能由可安装扩展动态加载。
