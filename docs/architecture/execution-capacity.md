# Managed Provider 外部占用与重启配额

本批只完善通用底座。一个占用表示一次 Managed Provider 调用可能留下的外部执行，不代表精确的 OS 进程数量或内存用量。
生产入口为 `registerEmbeddedWorkers` 的默认 Managed Provider source factory。
后续统一占用批次已让内置进程、MCP Tools 和外部 MCP 上下文进程共用该调度器；它们的逐进程账本、独立清理协议及服务归属见 `process-capacity.md`。
自定义 source factory、任意 Discovery source 与 Scenario 原始 executionNode 端口仍不受自动拦截。

## 派发与占用

| 阶段 | 持久化记录 | 调度含义 |
| --- | --- | --- |
| 获得本地名额、尚未请求启动 | `reserved`，固定 Invocation、Case/Run/Work、工具身份与执行 owner/lease | 计入本地 active |
| 调用 Execution Node 前的同步提交屏障 | `dispatched`，固定 requestId | 进程是否启动尚未知；屏障写失败则不派发 |
| Host 等待/清理结束 | `unknown` 或 `terminal_observed` | 在释放本地名额前安装 retained 外部占用 |
| 确定未派发，或独立清理证明获授权验证 | `released` 与 proofRef | 释放对应外部名额；永久键仍保留 |

`occupied = active + retained`，全局、Provider 版本、工具、Run、Work 五个维度共同参与准入。
转换发生在同步 finally 中：先建立 retained，再释放本地 lease，不给排队任务留下假空闲窗口。
即使 SQLite 结算失败，内存仍保留占用；重启根据更早提交的 dispatched 记录恢复。
排队保留原来的有界、按 Run 公平轮转与取消机制；恢复的占用不重新启动 Provider。
Host 容量/存储拒绝不算 Provider 故障，不会因此累积工具隔离预算。

每次 reserve 在排队后再次核对当前 Worker lease 与运行中的 Run。执行 owner 是宿主账本身份，不是 Worker ID，二者不混用。
Provider 包版本和工具版本独立保存，不要求二者字符串相等。

## 恢复与释放

单宿主启动时，在开放 Managed Provider 准入前重建所有未释放占用；即使超过新配置上限也保留全部旧占用并拒绝超额新调用。
只有停留在 reserved 的记录可凭“同步派发屏障从未提交”释放。这里依赖同一数据库只有一个活跃宿主；不支持多活宿主共享 SQLite。

升级迁移通过保存的 Provider Manifest 与精确工具 source/name/version 识别旧 executing/uncertain/completed 调用，全部按 unknown 恢复。
成功回执不是进程树清理证明。多版本映射有歧义时启动失败，不猜选版本；没有可映射 Manifest 的旧来源不属于本批可重建范围。
缺失或不匹配的 v2 进程归属不能伪造补齐，需独立修复/平台证明方案，不能靠删除占用绕过。

新增接口：

- `GET /api/security-tools/execution-capacity`：本地、保留及合计占用和维度计数。
- `GET /api/security-tools/execution-occupancy?idempotencyKey=...&caseId=...&runId=...`：指定归属的最小元数据，不释放或续跑。
- `POST /api/security-tools/execution-cleanup`：commandId、actor、reason、idempotencyKey、evidence；独立受控释放，不是执行重试接口。

复用 Invocation reconciliation 的宿主授权与验证端口，默认拒绝授权，默认签名验证器无预置信任根。
默认签名验证器验证 Ed25519、来源授权、撤销/有效期、执行归属及被接受节点的精确 launch/generation/request 身份；
占用层额外要求匹配的 v2 进程历史，即使 signed not_started 也不能用非进程证明绕过。
有 Receipt 时必须证明该精确结果；无 Receipt 时必须证明无效果，不能用普通“进程退出”文本代替。
授权、核验各有 10 秒等待上限，迟到结果不得释放。自定义端口属于可信宿主注入点，不由 Provider 自行提供。

释放审计和占用更新在同一事务中提交；同 commandId 同内容重放幂等、不同内容冲突，校验期间占用变化则拒绝提交。
已成功提交的旧 Invocation reconciliation 可由一秒有界轮询复用，仍需匹配进程历史与清理结论；不是重新执行旧命令。
释放只改变配额，不改 Invocation 的结果、不改 Work、不创建重试、不换工具版本，也不把审计读取当成授权。

## 清理与审计边界

GC 将所有未释放占用对应的包版本和 scratch 加入保护集合，即使 Invocation 已 completed 也不能回收这些执行资源。
共享审计新增 `executionOccupancy` 来源，观察状态和 proofRef 可按 Case/Run 引用；不返回输入、回执正文或签名材料。
投影是最终一致的状态观察，短暂状态可被略过，不宣称采集了全部进程历史。HTTP 参数只定位单用户自己的记录，不建设多租户权限模型；管理端口仍不暴露给模型/工具进程。

占用永久键上限 100,000、单 identity 8 KiB；释放审计上限 50,000、单记录 8 KiB；申请/恢复分别检查已有物理执行/恢复余量。
不删键腾空间，不提供 HTTP 改配额或强制清空接口；长期扩容/归档和多节点统一资源治理仍未完成。

特别注意：普通 close 成功仅是 terminal_observed。没有被接受的独立清理证明时，正常完成的调用也继续占名额，最终可能阻止该 Work 或其他调用。
这不是已经具备自动可信清理签发器；原生可信证明仍默认关闭。不能将本批描述为“所有工具自动恢复容量”或 Windows 生产验收通过。

## 验证

回归覆盖调度维度/公平准入、磁盘重开、两次恢复、三个 SIGKILL 断点（reserved/dispatched/结算未提交）、
派发屏障拒绝、迟到启动不发工具命令、正常/取消/清理失败的真实中性 Node Provider、存储拒绝不隔离 Provider、
签名篡改/撤销/过期/跨请求/非进程证明拒绝、精确 Receipt、并发幂等、事务回滚、旧账本歧义、GC 保护及只读审计归属。
Node 回归采用测试专用约束证明，不是 Windows 沙箱或独立原生报告验收。真实模型、24/72 小时长跑继续暂缓。
完整验证基线见 `../development-status-and-roadmap.md`。

后续分层归档批次已支持把 released Managed cleanup audit 及其签名 Evidence 受控压缩归档，同时保留占用身份、proofRef 和永久防重键；
透明 replay、损坏失败关闭和接口见 `governance-history-archive.md`。未知/活动占用不会被该机制归档或释放。
