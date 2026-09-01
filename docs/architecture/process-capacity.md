# 内置进程与 MCP 统一占用治理

## 覆盖范围

生产组合根创建一个 `ToolProviderFairScheduler`，默认 Managed Provider、内置 `process_execute`、
MCP Tools（发现/调用）与外部 MCP Resources/Prompts（读取）共用该实例。
Managed Provider 仍用原 Invocation 占用账本；其他受控入口用 `ProcessExecutionCapacity` 的逐进程账本。
两个账本的内存 retained key 使用独立命名空间，不能因 key 同名覆盖彼此。

| 入口 | 真实归属 | 记账单位 |
| --- | --- | --- |
| 默认 Managed Provider | 当前 Work/Invocation/执行 owner | 一次可能留下外部执行的 Invocation |
| 内置进程 | 当前 Work、父 Invocation 和进程 key | 一次进程启动 |
| MCP Tools 调用、MCP 上下文读取 | 当前 Work、父 Invocation、每个会话独立 key | 每个会话进程分别记账 |
| MCP 目录发现 | 宿主明确配置的服务归属 | 每个发现进程；不伪造 Work/Invocation |
| 未映射的旧进程历史 | 保存的 Case/Run/Work/lease 和进程 key | `legacy.unattributed` 保守占用，不猜工具来源 |

全局、来源版本、操作、Case/Run 和 Case/Run/Work 维度一起约束准入。
默认 global=16、perProvider=8、perTool=4、perRun=4、perWork=1；队列最多 256、等待最多 30 秒。
可由可信宿主设置 `executionSchedulingLimits`，没有 HTTP 强制清空/改配额接口。
这是执行名额治理，不是进程树子进程数、CPU/内存的精确计量，也不替代 Execution Node 的系统资源限制。

自定义来源治理批次已将显式注册的自定义 Discovery/Provider factory 和 Scenario governed execution port 接入同一逐进程账本。
旧原始工厂默认拒绝；Scenario 兼容 executionNode 只保留受调用约束的 HTTP，未声明模式默认禁止进程。
`GET /api/security-tools/process-capacity-policy` 返回配置上限、来源声明与开发逃生开关。
这不是任意同进程 JavaScript 的沙箱；详见 `governed-execution-sources.md`，不能把装配声明等同于全部外部副作用已隔离。

## 准入和重启

`acquire → reserved → 同步 beforeStart(requestId) → dispatched → unknown / terminal_observed → 独立证明释放`。

排队之前、获得名额之后、派发之前重新检查取消、租约和宿主授权回调。
Work 操作额外核对当前运行中的 Run、精确 Worker lease、父 Invocation 的 executing 状态；服务操作不制造这些数据库记录。
原有 Scope、输入授权、审批、MCP profile/schema 校验与节点证明仍独立生效，配额允许不是执行授权。

本地等待结束前先安装 retained，再释放 active；普通 close/进程退出只记观察状态，不释放外部占用。
结算写入失败仍保留内存占用；重启从此前已提交的 dispatched 恢复。迟到的进程启动仍处于派发屏障之后，
取消后拿到 descriptor 才发清理请求，不因此腾出名额或发起新动作。

只有从未提交派发屏障的 reserved 能以 `host:not_dispatched` 释放。
服务发现同样遵守这条规则：没有可信清理证明，重启时的再次发现可能被旧名额挡住。
不能通过变造服务身份绕开；应先取得证明并释放，或由运维明确评估后配置足够容量，旧名额仍保留。

生产启动先恢复两个账本，再按 `execution_process_journal` 查漏旧记录。
已有 Managed/进程占用记录（含 released）不重复收养；缺失来源的旧历史记 legacy，旧观察损坏/容量不足则拒绝启动。
没有任何持久化进程历史的旧外部动作无法据此还原，不能宣称全部恢复。
依赖一个 SQLite 只归一个活跃宿主；没有实现多活/多节点资源协调。

## 独立清理证明

`traceforge.process-cleanup.v1` 是逐进程清理证明，独立于 Invocation 结果证明。
它包含 occupancyId、不可变归属、精确 journal identity/launch、cleanup（terminal/not_started）、evidenceRef、
issuedAt/expiresAt、keyId 和 Ed25519 签名。签名消息为不含 signature 字段的 `canonicalJson`。

宿主必须注入 `processCleanupAuthorizer`；授权超时上限 10 秒，缺失、拒绝、无效或过期 grant 均不写释放。
复用 `toolRecoveryEvidenceAuthority` 的公钥、来源范围、有效期、撤销状态与独立 processAcceptance 节点集合。
验证器要求 v2 持久化 journal、精确 request/generation/launch、签名有效、签发不早于占用记录且不过期/超龄。
not_started 与已有启动观察矛盾时拒绝；journal 的普通退出状态不能替代独立证明。
没有 journal、没有接受的节点或没有签发器时保留名额，不能用调用方自行声明代替证明。

清理请求在等待授权前固定副本，证明与释放审计、占用状态在同一 SQLite 事务提交。
同 commandId 同内容幂等、不同内容冲突；成功重放也要当前宿主授权，但不把过去审计重新当成一次释放。
本地仍在等待时拒绝释放。清理不改 Invocation 结果，不创建 Work，不重试，不恢复旧工具目录。
需要核实执行结果时仍走原有 Invocation reconciliation；证明“进程已清理”并不证明动作没有副作用。

## 查询、审计与容量

- `GET /api/security-tools/execution-capacity`：共享调度器 active/retained/occupied 及分维度计数。
- `GET /api/security-tools/process-capacity-policy`：当前上限与生产接线覆盖范围。
- `GET /api/security-tools/process-occupancies?caseId=...&runId=...&limit=...&after=...`：最多 100 条、稳定 id 游标；服务同样可查。
- `GET /api/security-tools/process-occupancy?id=...&caseId=...&runId=...`：精确记录，最小元数据，无输入/命令环境/证明正文。
- `POST /api/security-tools/process-cleanup`：最多 64 KiB；commandId、actor、reason、occupancyId、evidence。

共享审计以 `processOccupancy` 引用真实 Work 记录。服务/legacy 不投影成伪造 Run 事件；通过占用查询和保存的清理命令审计核对事实。
状态补记为 observed_state，createdAt 是占用创建时间，不伪装成状态转换的发生时间。
这些 Case/Run 参数只做记录归属校验。产品是单用户工具，不建设多租户授权；后续宿主通道批次已给生产管理端口增加独立能力票据门禁，
不从模型/工具上下文或 actor 获取管理权。见 `foundation-host-channels.md`；这不等于任意同进程 JS 的沙箱隔离。

新占用永久键上限 100,000、identity 8 KiB、进程 key 1 KiB；清理命令上限 50,000、证明 64 KiB、审计 8 KiB。
数据库触发器禁止删除键或改写清理命令，准入/清理分别经过现有物理执行/恢复余量检查。
满额拒绝，不删账自动重开；永久键扩容仍待开发。

后续分层归档批次已支持将 released 的 process cleanup 签名原件/审计压缩到执行冷库，原表保留摘要 marker，
占用 identity/state/proofRef 和永久命令索引仍在热库。未知占用不归档；冷数据损坏拒绝启动和 replay。
接口、关联证明检查及容量边界见 `governance-history-archive.md`。永久键扩容仍未实现。

## 验证和未验收项

回归覆盖共享配额竞争、真实 HTTP Worker/MCP 接线、每进程计数、服务不伪造调用、取消队列与迟到启动、
派发/结算存储拒绝、签名/来源/节点/归属/过期拒绝、并发幂等、授权期间输入突变、原子回滚、查询分页边界，
以及 reserved/dispatched/结算未提交三个 SIGKILL 窗口后两次磁盘恢复。
MCP/内置节点使用协议夹具，签名使用测试密钥；真实平台清理签发、Windows 双模式、Linux 沙箱未因此通过验收。
没有新增原生可信签发器；真实模型与 24/72 小时长稳继续暂缓。完整基线见开发计划第 6 节。
