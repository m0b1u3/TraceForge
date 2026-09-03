# Scope 授权的固定策略版本与兼容升级

2026-09-01。本批针对单用户智能体底座，不增加账号、租户或应用 UI。`approvedBy` / `actor` 继续是本人的审计标签。

## 固定什么

新授权创建时，在同一 SQLite 事务内写入原 scope 记录及 `scenario_authorization_bindings`，保存精确 Package id/version/schemaRevision、绑定修订号、Definition 契约摘要和原 scope 正文摘要。
创建请求可提供 `definitionVersion` 选择版本；省略时只在这次**新建授权**时选择最新已安装版本，后续读取不会继续追随最新包。
列表接口返回 `policyBinding`，包含固定包、revision 和 available/recovery_required 诊断。

`SqliteScenarioAuthorizationService` 是统一解释入口：

- Action 与 Resource 授权都从固定包读取策略，不按 scenario kind 动态选择最新版本。
- Run 创建、调度、租约续期和恢复校验 scope 与 Run 包的策略兼容性。策略恢复错误拒绝派发，不为了消除错误而取消原 Run；原来的 scope 到期/撤销取消规则保留。
- 上下文资料的 Worker/Planner/Observer 选择、MCP 工具的输入授权、Run 版本迁移都使用同一固定 scope 解释。
- Provider Capability 和 Execution Node 资源授权继续使用通用授权端口，因而读取固定策略。
- 生产 Embedded Worker 的 Gateway 在目录选择、审批等待之后及实际派发前复检当前 scope 与 Work 所有权，覆盖默认接入的内置、场景及自定义工具。
  Gateway 同步授权回调错误使用异步函数会被拒绝；已进入执行账本后校验失败仍保守要求恢复，不伪造无副作用证明。

已保存的工具回执可按原身份回读，不等于重新执行或重新发放权限。授权固定不取代工具自身的 Action、Resource、审批和沙箱约束。
如果 scope 原文、固定契约不匹配，或对应包缺失，返回恢复诊断，不回退到其他版本。

## 历史授权与升级

旧数据库只新增旁表，不自动给历史授权补猜测版本。未绑定授权仍可查看和撤销；执行前必须显式确认。
即使目前只安装一个版本，也无法据此证明旧授权原来依据该版本批准。

可信宿主配置 `SecurityAgentFoundationOptions.authorizationUpgrade`：

- `assertTrusted(binding, contractFingerprint)`：同步当前信任验证器；缺失、拒绝或异步误用均阻断。
- `authorizer.authorize(request)`：独立业务授权器，默认拒绝；允许时必须返回授权引用与未来有效期，等待上限 10 秒。

管理通道提供以下入口，Worker/匿名调用不可使用：

- `POST /api/scenarios/authorizations/:scopeRef/policy-upgrade/preview`
- `POST /api/scenarios/authorizations/:scopeRef/policy-upgrade`
- `GET /api/scenarios/authorizations/:scopeRef/policy-upgrade?caseId=…&commandId=…`

预检请求为 caseId、expectedRevision、target（精确包绑定）；未绑定旧授权的 expectedRevision 为 0。
提交时增加 commandId、actor、reason 和预检返回的 planFingerprint。

两种操作共用上述流程：

1. `explicit_legacy_binding`：明确审核现有旧 scope 并指定已安装版本，留下“本次确认”审计，不伪造最初审批来源。
2. `compatible_upgrade`：固定到前向 schema/Definition 版本，原 scope/有效期/状态不变；生产声明式策略必须逐字段规范化后完全一致，解析出的权限 Envelope 也必须一致。旧函数引用比较只存在于显式开发/迁移兼容模式。

绑定到某个包版本与 Run 升级是两个不同事实。Run 可以继续使用原包，前提是与 scope 固定包共享同一授权实现。
涉及的未终结 Run 必须全部暂停，且无活动租约、待审批、开放调用或未确认释放的进程占用；升级不自动恢复 Run，也不处理未知占用。
改变权限语义的策略不允许覆盖旧授权：应创建新 scope 和适用的新 Run；当前不支持把既有 Run 静默改绑到新 scope。

Run 包和 scope 策略可以分别先后做兼容升级。若只升级了 Run，仍需保留旧 scope 固定的策略包；只有 scope 也完成升级后，授权执行链才可不依赖旧包。
这收紧了此前“仅目标包可以回放 Run”的解释：事件回放本身可行，不代表仍缺旧策略的授权执行也可放行。

## 持久化与恢复

预检不写绑定或审批事实。请求在等待授权前固定快照，指纹包括旧绑定、scope 内容/状态/有效期、目标契约以及关联 Run 状态。
授权结束后在事务内重新校验，随后绑定 revision 与不可变升级审计一起提交。绑定失败、审计失败、物理存储拒绝或进程强杀均不留下半次升级。
同 commandId 同请求重新授权后回读原结果，不重复增加 revision；同 ID 不同请求冲突。回读审计验证摘要，历史审计不能更新或删除。
审计按 Case/scope/command 查询，不经过模型。原 scope 记录、历史审批、工具回执与 Run 事件不改写。

绑定与升级审计各最多 50,000 条，绑定包正文最多 4 KiB，单审计最多 64 KiB；绑定新增使用执行物理余量，升级审计使用恢复物理余量。
scope 解析上限 1 MiB；升级最多关联 256 个 Run，单 Run 状态上限 2 MiB。满额拒绝新增，不自动删除历史腾空间。
同步回放仍依赖既有事件存储，未提供流式超大历史扫描或同步 JS CPU 抢占；10 秒截止只约束异步授权等待。

## 信任边界和剩余工作

固定的是**宿主已安装、已审核的包版本身份**。生产契约摘要覆盖绑定、Definition 和完整声明式 Scope Policy；授权由 SDK 固定解释器执行，不依赖 Package 闭包。未知字段、任意表达式、递归/容量越界和未声明资源均拒绝。
旧函数接口仍为测试/迁移兼容保留，相同函数引用只用于其保守兼容判断，不能证明两个实现语义等价；Foundation 生产默认拒绝这种旧合同。
后续受信装配批次已将签名材料和当前使用门禁接入固定策略入口，参见 [场景包审核材料](scenario-package-trust.md)。
文件验签与内存对象来源仍是两个条件：官方 `scenario.json` 加载链能把冻结对象关联到精确审核材料，手工旧对象仍须可信宿主明确关联；这不是下载、上传或自动安装证明。
缺失、替换或撤销阻断当前使用；后续 [无包依赖处置](scenario-run-disposal.md) 已提供独立授权的旧 Run 取证、停止和退役检查，不授予执行或清理证明权限，不开发任意上传执行器。

本批未实现权限语义变更的旧 Run 改绑、任意状态转换、自动排空、包上传安装、历史分区/无限扩容或平台级账号管理。
测试使用中性包和可控模型替身，验证真实 HTTP/SQLite/子进程路径；并未调用真实模型或恢复暂缓的 24/72 小时长测。
