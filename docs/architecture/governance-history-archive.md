# 执行治理历史的分层归档

## 目标和边界

本批处理已经完成独立核实的两类清理历史：默认 Managed Provider 的 cleanup audit，以及内置进程/MCP 的签名 process cleanup proof + audit。
它不归档活动/未知占用，不改变 Invocation/Work/Run，不签发清理证明，也不把进程退出当作证明。

占用表继续保留完整调度身份、状态、requestId 和 proofRef，作为准入和重启围栏；`execution_governance_history` 保留永久的
kind、清理命令、occupancy、Case/Run/Work、时间、proofRef、结论和 fingerprint。厚的证明/操作正文由既有执行归档压缩保存，
原表只留下带摘要的 marker。永久索引和占用身份不删除，所以同一命令仍不能再次产生效果。

MCP discovery 的 Run 可是明确配置的宿主服务归属。归档控制按已保存的 Case/Run 查询，不要求存在 Scenario Run，
因此不会为服务操作制造一个已完成 Work/Invocation。服务与 Work 的清理历史使用同一协议，但保留真实 ownership 种类。

## 可归档条件

- 对应占用必须已经是 `released`；审计 outcome/proofRef 必须与占用表中的实际释放依据一致。
- process cleanup 必须保留原始签名 Envelope；occupancyId、不可变 identity 和 `process-cleanup:sha256` 必须匹配。
- Managed cleanup 必须有已保存的 `recovery-evidence:sha256` Envelope；签名 Envelope 的 Invocation/ownership 必须匹配占用身份。
- 默认保留期为 24 小时；可信宿主可在构造控制器时设置，但 HTTP 请求不能修改。
- 一批最多 32 条、源正文合计最多 16 MiB；只有 independently authorized 控制事务可调用归档。

这些检查是在搬运时重新核对历史完整性，不重新判定旧证明现在是否仍有效。清理决定已经发生；归档只改变存储形式。
当前信任/授权仍用于新的清理或执行，不能用归档旧证明获得新权限。缺少持久化签名 Envelope 的自定义 Managed 验证结果不归档，
不能用 proofRef 文本代替证明原件。

## 原子性、回读与恢复

请求在等待宿主授权前固定副本。授权最长等待 10 秒，缺失、拒绝、过期以及提交前过期均不写任何冷数据。
同 commandId、同请求重放幂等但重新授权；不同请求冲突。一批中关联的 Managed Evidence、cleanup body、marker 与
`execution_archive_commands` 在一个 SQLite 事务提交，任一点失败全部回滚。

`readExecutionRow` 透明解压并核对原始长度、SHA-256、Envelope kind/key 和热表 marker 投影。
`readGovernanceHistory` 再核对永久索引、占用 identity/state/proofRef 和关联 Evidence。原清理命令的 replay 路径也使用该读取器，
不会因为正文变冷而绕过检查或再次释放名额。

启动时两类占用控制在开放准入前检查全部已归档清理记录。冷 payload 缺失、损坏、marker 不匹配或 Managed Evidence 损坏都会令启动失败；
不会退回“没有证明”的空闲状态。释放占用本身仍保持 released，不因读档错误自动变成一个可重试任务。
本批继续依赖一个 SQLite 只归一个活跃宿主，不提供多活协调。

## 接口和诊断

- `GET /api/security-tools/storage/governance-candidates?caseId=&runId=&kind=&limit=&after=`：最多 100 条稳定游标；返回永久身份、冷热状态和阻塞原因。
- `GET /api/security-tools/storage/governance-history?caseId=&runId=&kind=&key=`：单条最小诊断，不返回签名、证明正文、actor/reason 或结果正文。
- `POST /api/security-tools/storage/governance-archive`：`commandId/actor/reason/caseId/runId/entries`，默认未配置 authorizer 时拒绝。

Case/Run 参数先做索引归属校验，再读取或解压可能敏感的正文；它们只是单用户记录定位参数，不是授权模型/工具调用管理接口的凭据。
归档继续使用原 `execution_archive_usage/policy`（默认 1 GiB、200,000 条）和物理 recovery floor。
归档能够缩小热行、回收相应逻辑热存储预算，并利用压缩减少正文体积；不会删除永久键，不保证 gzip 后更小，
也不代表 SQLite 文件立即缩小或总存储无限。冷库满额/磁盘压力时保留热历史并拒绝归档。

## 验证和未验收项

新增 47 项回归覆盖两类清理历史的透明 replay、Scope/保留期/授权、并发幂等、关联 Evidence、逐条诊断/分页、逻辑/物理容量，
冷写/热替换/命令提交故障原子回滚，payload 缺失/篡改/marker 不匹配及重启失败关闭，以及两类历史各三个 SIGKILL 窗口后两次恢复。
生产 HTTP 用确定性夹具证明不会调用模型；不是原生平台证明、真实模型或 24/72 小时长稳验收。

尚未实现永久 key 的分区/扩容、独立外部对象存储、多节点冷库一致性、Archive key rotation、全事件/上下文历史归档，
产品是单用户工具，不规划账号/租户系统。actor 是本人的审计标签，Case/Run 是记录归属；二者都不授予模型或工具管理权限。
管理端口仍须与不可信模型/工具进程隔离。完整质量基线见开发计划第 6 节。
