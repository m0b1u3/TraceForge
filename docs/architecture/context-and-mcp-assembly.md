# 可审计上下文与受控 MCP 装配

本批是通用底座机制，不带具体安全技能、知识库内容或默认外部 MCP 服务。

## Skill / Knowledge 读取链

`ScenarioPackageResource.context` 显式声明 `skill | knowledge`、摘要、授权动作、所需能力、阶段和包内引用。
没有该声明的资源（例如迁移脚本）不会自动暴露。Skill 是有版本的指令资源，可附独立输入/输出契约，
通过准备/评估回执检查机械完成条件；不是独立脚本执行器，没有自动执行或额外授权。

可信 Host 通过 `SecurityAgentFoundationOptions.contextResourceContents` 安装文本：精确匹配 Package
id/version/schemaRevision 与资源 digest，正文及元数据指纹不可原位替换。`locator` 仅保留为包元数据，
不触发文件读取、URL 抓取或相对路径解析。缺失内容不尝试其他版本或其他来源。

Worker 的 Work/能力必须明确请求 `context.catalog` / `context.search` / `context.read`：

1. 通用工具经 Discovery/Gateway 提供，不把所有资源目录或正文塞进系统 Prompt。
2. `context.catalog` 按 Run 精确 Package、Scope、Work 租约、资源授权、能力及阶段筛选，分页返回摘要。
3. `context.read` 要求 id/digest，重新检查上述条件，分页返回正文；包内引用仍需独立读取和授权。
4. 结果保留 Package/资源版本、digest、Case/Run/Work、`untrusted_context` 和页面引用，进入已有
   Gateway Receipt、Worker Checkpoint、Cognitive Snapshot 的请求/上下文历史。引用不等于 Evidence Graph 验证结论。
5. Host 可通过 `revokedContextResources` 撤销 digest；撤销持久化且不能靠重新安装解除。撤销拒绝后续新读，
   **不删除历史回执或快照；每次 Worker 模型输入都按当前权限和资源生命周期重新过滤**，详见下节。

容量：单正文 64 KiB，内容库总预算 8 MiB（含键/指纹开销）、最多 2048 条；单 Package 最多 1024 个资源；
撤销键最多 8192 条。安装事务超额回滚并接入物理空间准入；已保存内容不自动删除。目录每页一条，正文每页最多
1200 字符并按 JSON 转义后 6500 字符再次收缩，`nextOffset` 指示后续页，避免正文被无提示截断。
读取审计沿用已有回执/检查点/快照容量与归档机制，不新增无界调用日志。内容库已有下述显式授权的单资源导出/退役接口，满额仍拒绝新增。

## 2026-08-31：授权检索与当前上下文投影

资源可声明 `validFrom`、`expiresAt` 和包内 `conflictsWith`；时间格式/顺序及引用在注册时校验。
尚未生效、过期、撤销、来源损坏或无权限的资源不进入当前选择集合。当前可见有效集合中显式冲突的双方都不能读取，
直到撤销其中一方或安装经过审核的新版本。底座不从一次样本或模型结论自行发明冲突规则。

`context.search` 在精确包和授权筛选后进行有界字面检索：查询最多 256 字符、8 个去重词，NFKC/大小写归一化，
全部词必须命中摘要或正文，按摘要/正文匹配程度确定性排序；返回摘要、版本、digest，而不是正文。
它复用现有按包/资源主键读取的文本库，扫描受单包 1024 条及总库 8 MiB 限制，**没有新增向量库、语义索引或外部联网检索**。
目录/检索的后续页须携带 `fingerprint`；可见集合变化后拒绝旧分页参数。`context.*` 工具合约版本升为 2，
旧的在途调用仍遵守既有合约指纹恢复门禁，不伪造兼容；已确认的旧回执不重执行。

`WorkerTranscriptEntry.receiptKey` 是 Runtime 根据实际调用键填写的溯源字段，不来自模型或 Tool payload。
通用 `WorkerModelContextPolicy` 接到真实 Embedded Worker，Server `PackageContextPolicy` 在生成模型快照前：

1. 按 Case/Run/Work/调用键核对持久化 binding；从原始 Receipt（支持现有归档回读）重建资源观察。
2. 用当前精确包、授权、租约、阶段、有效期、冲突和内容指纹检查资源；无效正文/摘要替换为不含内容的遗漏提示。
3. 去掉从首次无效观察起的模型/观察器派生笔记，清除旧 steering 及 Work 中进度/错误/审批说明副本；不修改恢复用原检查点。
4. 把核对时间、保留的 receipt/ref、遗漏原因与数量写入新快照 `contextGovernance`，旧快照和回执保留原样。

每轮最多处理 512 条 transcript。旧检查点没有 receiptKey 时，只在同 Work 的上下文调用账本中做最多 256 条兼容查找，
原始输出哈希仅作定位提示，最终正文仍来自回执；无法确定来源的旧上下文观察保守移除。超预算拒绝模型调用。
没有新增长期引用审计表，溯源复用现有调用键索引和回执容量，过滤清单受快照既有预算管理。

Model Runtime 新增 Host-only `beforeDispatch`：排队获得配额后、每次实际 Provider 调用前再次检查投影是否变化。
已准备请求失效则拒绝发送，不自动换模型，不将 Host 授权失败记作 Provider 熔断故障；该检查不传给 Provider，
非协作检查同样受调用截止控制，迟到的检查完成不能再触发模型请求。

包含资源历史的 Work 禁止原样模型快照重放（返回 409）；应经过 Worker 的当前投影续跑。
审计原件仍可读。长 Worker 快照 ID 超过既有路由参数上限时，可用：

- `GET /api/scenarios/cognitive-snapshot?snapshotId=...`
- `POST /api/scenarios/cognitive-snapshot-replays`，正文 `{ "snapshotId": "..." }`

旧路径接口保留并使用相同重放策略；新 ID 参数上限 2048 字符，没有放宽全局路由配置。

限制：这是受控资源观察及已识别派生笔记的过滤，**不是通用信息流/污染追踪**；不能清除旧说明被任意外部工具、图谱或用户文本
再次引用的所有副本，也不能撤回已经发往 Provider 的请求。已在执行的模型响应不会因资源撤销被自动取消，后续新调用重新检查。
Planner/Observer 的全局知识压缩与完整 compaction lineage 仍未完成；资源导出/退役与 Skill 契约见下面续批。

## 2026-08-31 续批：Skill 契约、外部资料和退役

### Skill 准备与评估

`context.skill` 声明 `version/input/output/checks`。采用明确的有界记录契约，而非完整 JSON Schema：
每端最多 32 字段，只支持 string/number/boolean/string_list、必填与字符串枚举；未知字段拒绝，
契约最多 4096 字符，每份输入/输出最多 2048 字符，完成条件最多 16 个输出标量等值检查。
字串最多 1024 字符、列表最多 32 项且每项最多 512 字符；整体仍受 6500 字符回执预算约束。

- `context.skill.prepare` 校验当前可用指令资源、独立 Skill 动作授权和输入，返回契约与准备调用键。
- `context.skill.evaluate` 只接受同 Case/Run/Work、已完成且成功的准备回执；复核资源 digest、契约指纹、
  有效期和当前授权，校验输出并逐条报告条件。两步通过原 Gateway 留痕，不另建 Skill 执行账本。
- `completed=true` 仅表示预设机械条件匹配，固定 `findingVerified=false`；不能改变 Evidence Graph 或跳过因果验证。
  模型自行填写一个 true 值不是安全证明。没有模型评分器或独立技能调度器；复杂语义评估未交付。
- 只有声明 Skill 契约的包才暴露这两个工具。旧的纯指令 Skill 继续可读，不自动获得评估契约。
  通用 `context.catalog/read/search` 合约升为 3；旧在途调用须经过既有合约恢复门禁，不能静默换版本。

### 外部 MCP 资料

Host 显式配置 `mcpContextServers`，Package 用 `context.external` 固定 source、profileDigest、kind、target 和可选固定参数。
profileDigest 覆盖服务器身份、版本、审核版本及进程权限/资源/启动配置（不包含诊断回调），审核策略变化需递增 reviewVersion。
采用固定 2025-03-26 的 [Resources](https://modelcontextprotocol.io/specification/2025-03-26/server/resources) 与
[Prompts](https://modelcontextprotocol.io/specification/2025-03-26/server/prompts) 子集：

1. 目录从审核后的 Package 元数据生成，启动时不联系服务、不自动读取 URI；未加载远端正文仅按摘要检索。
2. 显式 `context.read` 才启动独立 Execution Node 进程，检查隔离证明和服务器身份；按资源类型走
   `resources/list → resources/read` 或 `prompts/list → prompts/get`，一次进程只读取一个固定资源。
3. `context.resource` 与 `mcp.resource/mcp.prompt` 都由精确 Package 的 Scope 授权，目标和 Prompt 参数不接受模型覆盖。
   读取前、发送前和响应后都复查；Scope/撤销变化时不缓存、不投递。正文指纹必须等于已审核 digest。
4. Resource 只接受一条 URI 精确匹配的文本；Prompt 最多 32 条 user/assistant 文本消息，固定参数最多 16 项。
   Prompt 规范化为 `[{role,content:{type:"text",text}}]` JSON 后校验 digest，角色只是资料字段，不加入模型消息角色。
   description/annotations/服务器 instructions 不提升为系统指令，二进制、嵌套资源、系统角色拒绝。
5. 进程确认清理后才缓存正文，复用原 64 KiB/8 MiB 库、分页回执、撤销投影、快照和重启恢复。
   已确认回执恢复不重新连接 MCP；新的读取（包括新页）重新取回并校验内容，不悄悄采用新版本。
6. 连接/内容/目录/隔离/清理异常一旦进入外部调用路径，交给 Gateway 的 uncertain/对账机制并阻塞 Work，
   不伪造成功或自动重试。本地权限拒绝不启动进程。

这是固定文本快照，不是实时订阅：离线时历史已确认快照只按本地版本/授权/有效期验证，不能推断远端已经撤销或更新。
部署必须为时效性资料配置 expiresAt 或同步显式撤销。资源模板、动态参数、目录分页、HTTP 传输、订阅、热更新仍不支持。
每个远端目录上限 128 项。通用 Runtime 已接入非协作等待截止与取消信号，详细边界见 `cancellation-and-deadlines.md`；停止等待不等于远端动作已撤销。

### 单资源导出与退役

`POST /api/scenarios/context-resources/lifecycle` 是 Host 管理接口，不是模型工具；必须注入
`contextLifecycleAuthorizer`（默认拒绝），逐次检查授权引用/截止时间，命令绑定 actor/reason/package/resourceId/digest。
export 返回一个已加载且当前未撤销/退役资源的 manifest 和正文，格式 `traceforge-context-resource/v1`；
重复导出也必须重新授权、重新读取，不能通过旧命令复活撤销内容。它不是完整资源包的签名归档或跨主机导入协议。

retire 只在该精确包不存在非 completed/cancelled Run 时删除内容缓存；failed/blocked/paused 等可恢复任务会阻止回收。
允许回收已撤销的完整原文，但先验证缓存完整性；一事务写入永久退役标记与管理审计并删除缓存，任一写入失败全部回滚。
回执、快照、检查点、撤销键都不删除，退役资源不能原版本重装；重启配置应移除其 content 安装项，重新使用需发布新包版本。
退役命令重放返回已完成结果。管理账本与退役标记各最多 2048 条，禁止删除/改写，审计写入接物理准入；满额拒绝操作，
不会删除审计历史腾空间。回收缓存不等于立即收缩 SQLite 文件，也不代表历史敏感文本被擦除。

## 跨角色来源与压缩生命周期（2026-08-31）

资源 `context.readerRoles` 显式列出 worker/planner/observer，未声明时只允许 Worker。角色可读不等于工具可执行；
Planner/Observer 仍检查 Run 的精确包、Scope、当前阶段和能力；Worker 检查自己的 Work 能力，不能借源 Work 的权限。
已有安装记录的元数据不能原位扩大 readerRoles，应发布经过审核的新 Package 版本。

Host `RunContextPolicy` 从同 Run 的持久化上下文调用/回执建立来源清单，投影时重新验证版本、digest、授权、有效期、冲突和退役状态。
Planner 产生的 Work、Observer 的 steering 和 Worker 决策按模型快照保存保守的来源依赖集：关联该轮所有有效来源，
不是声称精确识别模型用了哪句话。失效后屏蔽对应 Work/输出摘要、派生 Work/重试后代、指令和具有已知来源关系的图节点，
保留身份与状态，原始 Run、Graph、Receipt、Checkpoint、Snapshot 不改写。若存在失效来源，当前事件文本保守省略。
这是结构化来源追踪，不是任意自然语言复制内容的污染检测；没有已知引用的手工复制文本不能保证被追踪。

三角色发送前与结果应用前检查来源指纹。调用中撤销时，已经发送的推理未必立即停止，但返回动作不会继续应用；
Worker 进入失败状态后须通过已有显式续跑重新判断，不执行旧推理提出的“刷新”动作。
来源变化本身可唤醒 Planner/Observer，不要求 Run/Graph revision 一起变化。Observer 使用有界伴随表保存该评估身份，旧表历史保留。
含资源历史的角色快照不能原样 replay；审计查看不受影响，继续执行必须走当前授权投影。

`ContextCompactionRuntime` 在授权投影后、模型快照前处理长文本。默认按 24,000 字符触发，文本预算 16,000 字符，
输出 JSON 上限 256 KiB、原输入硬上限 1 MiB、层级 32、文本条目 512、压缩截止 1 秒。
只转换 `summary/resultSummary/rationale` 叙述字段，保留目标、任务指令、ID、状态、引用、工具 Schema、审批和检查点结构；
受保护字段太大时拒绝，不能把关键身份裁掉来适配预算。原位置以 `contextTextId` 指向独立 `untrusted_summary` 摘录。
当前默认实现是带省略标记的首尾摘录，不是模型语义总结；`semanticQualityVerified=false`。

启用该链时，Planner/Observer 保留本次供应的全部 Work/输出/指令和可见图节点，Worker 不再先将 transcript 裁成末尾 12 条。
仍有上述输入上限；Observer/Planner 调用者供应的 recentEvents 仍是有界窗口，并未实现全部历史事件压缩。
原记录留在原始存储，压缩表只保存摘录、路径、指纹及归属；摘要不写回 Evidence Graph，也不提升证据可信度。

压缩记录 `prepared → completed/failed` 持久化；重启将未完成记录标为失败。复用必须匹配 Case/Run/角色、原输入、
来源指纹、受保护结构、适配器版本和预算，输出条目必须精确对应原路径。超时/无效输出回退原投影，仅当原投影仍在安全预算内；
否则明确拒绝。相同失败身份不会后台重试，新输入、来源、适配器版本或预算产生新身份。存储写入失败不伪造成功。

容量/保留：压缩记录最多 4096 条，身份 JSON 64 KiB、摘录 JSON 128 KiB；派生记录最多 8192 条、来源 JSON 32 KiB；
Observer 伴随评估最多 4096 条、决策 JSON 64 KiB。写入均接物理空间准入，不自动删历史腾空间。
单 Run 来源调用最多 256、派生记录最多 512，Work/输出/指令各最多 512，图节点 2048、图边 4096；超限拒绝新模型装配。
因此仍需后续规模扩展/归档方案，不能宣称已具备无限长期运行能力。

## MCP 执行链

Host 显式配置 `mcpServers`；`createFoundationMcpSource` 将其接到现有 Discovery、Gateway、Execution Node。
没有 Execution Node 时组合即拒绝。节点返回的 sandbox、文件系统/资源限制及权限指纹必须匹配；
MCP 不接 `packages/extension` 的开发 stdio 客户端，不提供 unsandboxed 开关，不修改原生信任默认值。

当前支持固定 `2025-03-26` 的 stdio JSON-RPC Tools 子集，参考官方
[传输规范](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)、
[初始化生命周期](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle) 与
[Tools 规范](https://modelcontextprotocol.io/specification/2025-03-26/server/tools)。
实现 initialize → initialized → tools/list → tools/call；不宣称完整 MCP 协议覆盖。

- 工具 allowlist、description、Schema、能力、风险、权限需求、超时来自 Host 审核策略。远端 Schema 必须精确匹配，
  annotations/instructions 不影响审批、不注入系统提示。Provider 身份/版本握手是协议一致性检查，不是独立签名证明。
- 生产适配必须提供 `validateInput` 和 `authorizeInput`：一个校验输入，另一个根据 Scope 限制实际目标/资源。
  仅允许工具名或仅校验 JSON Schema 不足以授权目标；节点权限必须限定为部署资产与明确授权资源，不得给进程宽泛宿主访问权。
- 精确 Run Package 的动作/资源策略与 Work 执行权在进程启动前和 tools/call 前重复检查。高风险操作仍进入已有审批流程。
  远端工具映射、动作、进程配置和服务器身份参与工具版本指纹；输入校验器/授权函数变更仍要求部署方递增审核版本。
- 每次发现和每次调用各自使用独立进程，调用进程重新握手/核对 Schema；以本次 Case/Run/Work/租约归属启动，
  不跨 Run 复用 MCP 会话。进程内部不接收 Host 授权 envelope，不协商模型 sampling、roots 或 Host 反向能力。
- 复用 Execution Node 的请求/帧/累计输出/租约/资源预算；工具超时取消会请求停止。进程清理失败不能发布目录或确认成功，
  已派发调用的异常/超时由 Gateway 标为 uncertain，不能自动重放。历史已确认回执可在恢复时精确回读而不再发 tools/call。
- 原始结果受帧上限约束并进入回执；Provider/digest/trust 留在 metadata，模型只见有界蒸馏。
  MCP 返回 URI 不自动注册为可信证据引用。

限制：Tools 只支持单页最多 128 个工具的审核目录；分页目录、远程 HTTP、sampling/elicitation、
自动工具变更/热替换均未交付。Resources/Prompts 通过上述独立上下文入口装配。发现变更需重新发现/审核，不悄悄采纳新 Schema。
通用 Discovery、Execution Node RPC 和 Provider 请求已有独立截止；用户停止/执行权变化已接入 Worker 和 Gateway。
不配合取消的任意第三方工具仍不能保证真正停止，未知副作用必须保留恢复围栏，不能把 Host 超时当清理证明。
需要 Host Broker 才能完成的外部网络/秘密访问尚未通过标准 MCP 反向调用开放，不能据此放宽沙箱来“跑通”。

## 验证边界与后续批次

新增测试通过真实 HTTP Foundation/Worker/Gateway/SQLite/快照/恢复链；模型决策由确定性夹具给出，
MCP Execution Node 为明确标记的协议模拟器，不是原生沙箱认证。另有分片 UTF-8、超限、目录变化、风险标签、
输入/目标拒绝、缺失隔离证明、清理失败和重启不重放回归。实际模型调用次数仍为零。

当前已完成包内检索、资源生命周期筛选、三角色来源投影、Skill 契约/回执评估、固定 MCP 文本装配、单资源导出/退役，以及有界摘录压缩的持久化生命周期。
统一取消与 Discovery/RPC 截止已由后续批次接线；审计批次已提供归属游标、压缩缓存/实际模型输入 manifest 的分离事实与只读引用，
见 `agent-audit-replay.md`。默认 Managed Provider 的持久化占用/重启配额已由 `execution-capacity.md` 所述批次交付。
内置进程与 MCP Tools/Resources/Prompts 已在后续批次共用调度上限并按进程持久化，见 `process-capacity.md`。
目录发现保留服务归属；普通结束不释放名额，重启发现也可能被未取得独立清理证明的旧占用阻止。
后续资源迁移批次已完成上下文专用完整清单的签名导入/导出、原子发布与当前签名者信任检查，见 `context-package-transfer.md`。
该能力要求目标宿主已有匹配的 Package 契约，不安装可执行 Scenario/授权代码，不复制 MCP 配置或启动进程；混合资产包迁移仍未实现。
压缩语义效果需在真实模型配置到位后独立验收。应用和具体安全场景仍不解冻。
