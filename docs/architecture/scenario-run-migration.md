# Scenario 包升级与旧 Run 的保留状态迁移

2026-09-01。本批只交付已安装、已审核版本之间的 `preserve_state` 迁移，不安装可执行包，不提供任意状态转换脚本。
这是单用户底座管理能力，不是账号或租户管理；`actor` 仅为本人的操作审计标签。

## 契约与职责

- Core 只认识通用包绑定和 `migrate_run_package` / `run_package_migrated`。迁移事件记录新旧包绑定、定义版本、授权引用和原因；回放校验旧绑定与前向版本关系。
- Scenario SDK 检查保留状态兼容性。包 ID 不变，包版本不同，schemaRevision 和 Definition.version 严格增加；Definition 除 version 外完全相同。
- 输出 kind/schema version 清单必须相同，历史输出交由目标 Schema 重新校验，但不改写输出及证据引用。
- 新旧包必须共享同一 `parseScope`、`authorizeResource` 和 `createToolSources` 函数引用。宿主不能自动证明两个不同 JS 实现语义等价，因此本批保守拒绝这种替换。
- Server 负责当前授权、资源信任、执行占用、检查点验证、SQLite 原子提交及受保护管理路由；Core 不引入数据库、资源加载或具体安全场景。

目标包必须包含唯一直接对应的 migration manifest step，以及宿主显式提供的不可变资源正文，例如：

```json
{
  "format": "traceforge.run-migration.v1",
  "mode": "preserve_state",
  "from": { "id": "neutral", "version": "1.0.0", "schemaRevision": 1 },
  "to": { "id": "neutral", "version": "2.0.0", "schemaRevision": 2 }
}
```

正文绑定精确版本对，并校验资源 manifest 与内容摘要。路径只是声明，不会据此读任意文件或联网下载。
没有直接迁移步骤时拒绝，不自动寻找多跳路线；资源变更不等于自动执行新工具。

## 操作与授权

可信宿主通过 `SecurityAgentFoundationOptions.scenarioRunMigration` 提供：

- `resources`：显式安装的迁移声明正文。
- `assertTrusted(binding, contractFingerprint)`：同步的当前信任校验；未配置或错误使用异步函数均拒绝。
- `authorizer.authorize(request)`：独立的迁移业务授权，允许时返回 authorizationRef 和 expiresAt；默认拒绝。

契约指纹覆盖绑定、Definition、输出标识和资源/迁移清单，不是可执行 JS 代码签名。宿主仍需独立审核所安装代码及其依赖；一个无条件放行回调不构成真实信任体系。
资源还必须通过既有生命周期/当前信任验证；本批支持可读取的本地上下文和迁移声明。外部上下文及其他可执行/二进制资产缺少专用迁移验证器时拒绝。

管理通道提供：

- `POST /api/scenarios/runs/:runId/package-migration/preview`：caseId、expectedRevision、target；返回 eligible、blockers、plan、planFingerprint，不写入迁移事实。
- `POST /api/scenarios/runs/:runId/package-migration`：追加 commandId、actor、reason、planFingerprint；重新检查并授权迁移。
- `GET /api/scenarios/runs/:runId/package-migration?caseId=…&commandId=…`：查询该 Run 的持久化审计。

这些入口由既有 Foundation 管理通道保护；Worker/匿名调用不具备权限。迁移权限不替代 scope 授权，也不生成新 scope。
预检失败返回 eligible=false；非法输入返回 400，提交冲突/拒绝当前统一返回 409。没有 UI/桌面桥接接线。

## 保留事实与提交边界

Run 必须暂停。活动租约、正在运行/等待审批的 Work、待批记录、未完成或结果未知 Invocation，以及未确认释放的进程/Managed 占用均阻止迁移。
完成、失败、阻塞 Work 中保留的历史租约编号不会被擦除，也不会单凭这个历史编号判为活动执行；独立活动租约表与执行账本仍须通过检查。

所有已有检查点必须完整、v2 精确匹配 Case/Run/Work/WorkKey，且不含 pendingInvocation，并通过既有调用账本验证。
原检查点引用、内容、已用轮数、历史审批、输出和证据引用保留。迁移不释放未知占用、不重试工具、不改变幂等键、不制造执行或清理回执。

请求先固定快照，预检指纹覆盖状态、契约、scope、资源及检查点摘要；异步授权后重做预检，事务内再检查同步状态及授权有效期。
一个 SQLite 事务同时写入事件、绑定/定义版本投影和不可变迁移审计；任一步失败全部回滚。提交后才发布变更通知，共享审计投影可补记迁移事件。
同 commandId 同请求重新授权后返回原审计，不追加事件；不同请求冲突。回读检查审计摘要及其事件引用，修改或删除历史受触发器阻止。

迁移成功后 Run 仍暂停。只有显式恢复后才能重新领取旧 Work，领取必须使用新租约。已提交的事件可在仅安装目标包时回放；
初次迁移需要新旧包同时安装，迁移命令的授权重放也需要新旧包当前受信。只读审计查询并不执行迁移或发放权限。
授权策略版本固定后，Run 回放与授权执行需区分：只升级 Run 而未升级 scope 时，后续授权仍依赖 scope 固定的旧包。
应通过独立的兼容授权升级将 scope 绑定至目标版本，再移除旧策略包；不能因为 Run 已迁移就跳过授权固定。

## 有界性与未覆盖项

- 单次预检/授权各有 10 秒等待截止；最多 256 个 Work、2 MiB Run 状态、16 MiB 检查点聚合和每包 128 个待验证资源。
- 单迁移资源最多 64 KiB，全库最多 1,024 条/8 MiB；迁移审计最多 50,000 条、每条 64 KiB。新增写入使用既有物理存储准入，满额拒绝，不删账自动恢复。
- 上述截止不能抢占同进程恶意 JS 的同步死循环；可信宿主回调不是隔离沙箱。
- 不支持改变阶段/Work/输出结构、任意 schema 转换、自动排空、多跳/降级、任意可执行包安装、混合资产验证、迁移历史归档/分区扩容。
- 后续授权固定批次已移除按最新包解释 scope 的路径：迁移预检使用固定策略，并把绑定修订和 scope 一起纳入指纹。
  历史未绑定授权须先明确恢复；参见 [固定授权与兼容升级](pinned-scope-authorization.md)。
- 后续 [场景包审核材料](scenario-package-trust.md) 批次已为本地入口/依赖提供不可变材料、签名和当前使用复检，迁移的 installed 解析同样检查当前信任。
  内存对象与文件的关系仍须可信宿主确认；包已被撤销时不能借迁移绕过原包门禁。
- 后续 [无包依赖处置](scenario-run-disposal.md) 已覆盖旧 Run 的取证、停止及独立退役检查，不恢复执行、不迁移失信包、不替代未知占用的清理证明。

验证覆盖原子回滚、并发/重复提交、撤销与异步竞态、历史审批/输出/证据引用/检查点保留、仅目标包回放、显式恢复和生产管理路由。
在投影写入、审计写入、提交完成三个窗口真实 SIGKILL，并各用两次新宿主回读验证事务边界。测试使用中性 fixture，不代表真实模型或具体场景已验收。
