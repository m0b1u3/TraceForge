# Agent 审计协议与恢复读取

本批只改通用底座、共享协议及回归，不修改应用界面或具体场景。事件重放是读取事实，不是恢复执行命令。

## 协议与归属

保留既有 `protocolVersion: 2`、Turn/Item 方法和数字 `after` 接口，新增共享 decoder 与有界顺序读取器。
`controlChange` 可以携带可选的 `audit.version: 1` 元数据；没有把摘要、取消或恢复结果伪装成工具调用。

- Event ID 唯一；sequence 是 Run 内的安全整数。Case 必须匹配 Run；同一 Run/Turn 的 Work、role 不可改变。
- Item 身份属于 `(Run, Turn, Item ID)`，不能假定模型给出的短 ID 在不同 Work/Turn 间全局唯一。同一身份的类型不可改变。
- SQLite 行索引与 JSON 内的 ID、sequence、Case/Run/Work/Turn/role/method/Item/时间必须匹配。
- 不支持的协议版本、损坏数据、缺口、未来游标明确报错，不忽略坏记录后向前移动。
- `AgentEventSequenceReader` 默认保存 256 个待补事件和 256 个最近已交付事件；重复只交付一次，冲突拒绝，乱序等待缺口补齐。
  超出窗口要求重新分页读取，不扩大内存队列；窗口外旧记录明确返回 `stale`，不是声称已验证其内容相同。

新接口：

| GET 路径 | 参数 | 语义 |
| --- | --- | --- |
| `/api/scenarios/runs/:runId/agent-event-replay` | `caseId`、可选 `cursor`、`limit` 1–1000 | 带归属与事件锚点的只读分页 |
| `/api/scenarios/runs/:runId/agent-audit-reference` | `caseId`、`source`、`sourceId` | 最小化来源元数据，不返回正文或重试动作 |
| `/api/scenarios/runs/:runId/agent-events` | 既有数字 `after`、`limit` | 兼容旧客户端；无法证明传入数字来自哪个 Run |

新 cursor 是版本化 Base64URL JSON，包含 Case/Run、sequence 与该位置 Event ID。换 Run、换 Case 或恢复了不含该锚点的数据库均拒绝。
它不是签名凭据或权限令牌。TraceForge 是单用户工具；归属校验用于定位本人的 Case/Run，管理读取仍不暴露给模型/工具进程。旧 UI 仍使用兼容接口，本批没有迁移 UI。
读取锚点、事件页与 high-water sequence 位于同一个 SQLite 读事务；GET 不补记、不调用模型、不续跑 Work、不执行工具。
单页返回 `hasMore: false` 仅说明已到事件表尾部，不代表源记录都投影完毕。

## 持久化事实与补记

`AgentAuditProjection` 只依赖 SQLite 和事件 Writer，无执行端口。生产宿主在 Run 变化时、启动恢复后、每秒执行一次有界补记。
每种源一次最多读取 100 条候选（内部可设 1–1000），不是把全部记录载入内存；模型/审批终态补偿也分批执行。
Worker 快照补偿只接管宿主启动时已经存在的 rowid 范围，后续定时补记不能误终止仍在执行动作的新快照。
每个源事实的 Turn 起始、记录 Item、Turn 结束与永久 source key 在一个事务中提交。相同 key 内容冲突拒绝；重复补记不再次发布。
升级前半段控制记录已经提交时，仅补缺失部分；审批 Item 结束但 Turn 缺失也能恢复。

| 来源 | 记录的事实 | 不得推断 |
| --- | --- | --- |
| `scenario_events` | 原始控制 revision，包括取消/暂停/恢复/完成等；兼容旧控制 Turn 身份 | 取消等于外部进程已停止 |
| `compaction` | 摘录缓存 prepared/completed/failed、独立来源 ID | 缓存完成等于模型实际使用摘要、语义可靠或证据成立 |
| `contextSnapshot` | 实际模型输入 manifest 中的 completed/fallback、关联 compaction ID 和 Work | 强制再次生成摘要或读取失效资源正文 |
| `invocation` | 曾观察到执行账本 uncertain，明确为 `observed_state` | 当前仍 uncertain，或全部中间执行状态都已采集 |
| `executionOccupancy` | Managed Provider 外部占用的状态观察、对应 requestId/proofRef | Host 等待结束等于释放、或占用释放允许自动重试 |
| `recoveryCommand` | 恢复命令 registered | 恢复成功或应自动续跑 |
| `reconciliation` | 独立对账的 outcome、请求的 resolution、授权结论与证据指纹 | denied/rejected 也构成清理证明 |

审计 Turn/Item 的 completed 指“这条事实记录完成”。所有新增事实带 `automaticRetryAllowed: false`。
未知 Invocation 和后续已确认的 reconciliation 使用不同事实身份；旧观察不被覆写，引用读取可以返回当前账本状态。
Compaction 是跨模型决策可复用的缓存，因此它本身没有虚构 Work/模型 Turn；实际使用关系通过 contextSnapshot 关联。
引用读取不返回原始提示词、摘要正文、模型输出、恢复请求中的秘密或工具结果。恢复命令与对账引用经过既有冷热归档完整性读取。
当前资源授权/版本校验仍由上下文执行链负责；审计读取不给模型重新使用旧资源的权限。

模型账本新增可空 `termination_kind`，在同一 finish 写入中保留取消，启动接管明确记录 interrupted；旧 status 字段兼容保留。
取消事件未发布就崩溃时，不再仅凭错误文字把取消重建为 failed。旧行没有该结构化信息时不补造取消事实。

## 故障、容量与一致性边界

- 事件持久化后才通知订阅者。外层事务未提交时延迟通知；回滚不发布虚假事件。单个回调报错不影响其余监听或已提交事实。
- 通知是 best effort。客户端应订阅后分页补读，用共享顺序读取器合并重复与乱序；断线恢复以持久化 cursor 为准。
- 审计是可恢复的最终一致投影，不与业务事务强耦合。补记失败保留源数据并标为 `delayed`；不能因为审计满额而阻止控制取消。
  生产的模型/Worker/快照生命周期通过 best-effort Writer 接入，避免排队取消的 Promise 或名额释放被事件写入异常打断；
  执行本身仍须通过原有持久化、授权和围栏。审计满额拒绝的是审计写入，不是声称已经持久化所有实时进度。
  replay 响应附带投影健康状态；`current_pass_completed` 仅表示上次有界扫描完成，不是全局业务水位证明。
- 新事件默认最多 200,000 条、事件 JSON 合计 256 MiB、单事件 128 KiB，并检查物理恢复余量。索引/永久键另受物理数据库容量约束。
  原有超额历史保留，新增写入拒绝；事件及 source key 不可删除/覆写。没有提供公共接口任意扩大配额或删除永久键。
- 原始来源表有各自的存储边界；本批没有完成所有历史事件的冷热归档、任意自然语言来源追踪或管理读取的调用来源隔离。
- 一秒轮询可能略过很短暂的 prepared/uncertain 中间状态；不会把未观察到的过程补造成完整状态机历史。
  durable 控制/对账/模型输入事实可以补记；可变源状态只保证当前读到的观察。按序指补记后的提交顺序，不是不同源的真实因果时间全序。
- 新宿主可以分批补记旧快照；同一宿主新快照丢失的完整 Worker Turn 终态仍需下次启动接管，不能在动作运行期间根据模型快照完成伪造 Turn 完成。

## 验证

共享 codec/顺序读取器、数据库游标/索引/缺口/版本/外层回滚/配额、实际 HTTP 取消与断线补读、磁盘重开、归档引用均有回归。
三个隔离子进程 SIGKILL 断点覆盖源提交、审计事务未提交、审计事务已提交，两次重新打开数据库检查幂等与游标。
HTTP 回归人为耗尽审计配额，确认取消继续传播，恢复配额后补记，重启不重复工具执行。
完整基线以 `docs/development-status-and-roadmap.md` 为准；真实模型、Windows 实机及 24/72 小时长跑继续暂缓。
