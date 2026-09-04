# TraceForge 当前开发进度与生产化计划

更新日期：2026-09-04

当前排期调整（2026-08-31，用户要求）：跳过实际 24/72 小时超长长稳测试，状态记为“暂缓、未执行”，不再作为后续底座开发的前置阻塞。
保留测试入口、已有短时结果及长期稳定性风险，不安排自动或后台长跑，也不将跳过等同于验收通过。
下文历史批次中的长稳待验收记录保留；当前排期以此调整和第 7 节为准。平台隔离、授权、证据门禁及应用/场景冻结不变。

追加排期调整（2026-08-31，用户要求）：真实模型联调也先跳过，状态记为“暂缓、未执行”，待用户后续提供模型配置再恢复。
保留验收入口及 `not_run / modelApiCalls=0` 的实际结果，不作为后续通用底座开发的前置阻塞，不以离线回归替代真实模型验收。

整改优先级调整（2026-09-03，用户要求）：以 [TraceForge 继续开发前整改计划](remediation-plan-2026-09-03.md) 作为后续任务基线。
三个 P0 已在同一批次完成：Desktop 本机控制通道和 LLM Secret Store 已接线，旧 MCP 直接启动/路由已拆除，Web 0.1 同进程/direct Browser 实现已删除。Linux 本机部署的仓库实现也已闭环：正式 Linux Desktop 收窄为 DEB，安装 AppArmor 与固定 helper/manifest，并由瞬态 systemd user scope 提供本机 cgroup delegation；便携/直接启动明确关闭进程能力。协议 2/19 类真机终验等待可用 Linux x64。Web Scenario 的手写运行物已完成 6 个 TypeScript 模块与可复现签名构建；Cognitive Runtime 已承接 Planner、Observer、Structured Worker 的完整模型决策监督和上下文治理。Brokered Browser 的无场景 Core、Host/Controller 协议、Chromium CDP 策略、真实 pipe transport、页面观察/动作、人工接管恢复、可复现 Controller bundle、真实 macOS Chrome 集成、Build Attestation、Source Lock、离线评审签名、安全解压和 v3 整树发行安装门禁均已实现；当前只继续执行官方 Chromium 固定源码的真实双构建、SBOM/NOTICE、安全/许可证材料、各平台锁定产物和可用真机上的原生隔离证明。生产 Browser 在这些验收完成前保持关闭。随后才用最小 Code Audit Scenario 验证底座通用性。Foundation 整改与 Scenario 整改分别归档，不把 Web 语义写回 Core。

## 1. 项目目标

TraceForge 的目标不是通用编程 Agent，也不是某个漏洞扫描器，而是一套独立运行的通用安全智能体底座。底座负责认知调度、黑板协作、证据生命周期、上下文治理、工具运行、安全执行和人工审批；Web 黑盒、白盒审计、红队横向等能力通过 Scenario Profile、Worker 能力和受控工具 Provider 装配。

目标协同结构不是固定两个 Agent。Planner 和 Observer 是常驻的认知与仲裁角色，执行侧按照 Scenario Profile 和任务压力动态创建 Research、Validation、Review、Report 等 Worker。所有角色通过持久化 Run Event、Work Package 和 Evidence Graph 协作，不通过共享自然语言聊天记录协作。

## 2. 进度口径

本文中的“已落地”表示代码、类型、持久化模型和自动化测试已经存在，不代表已经完成真实环境长期运行验收。“生产可用”还要求安装升级、故障恢复、性能容量、安全边界、操作界面和真实授权环境评测全部通过。

当前工程估算如下：

| 范围 | 完成度估算 | 说明 |
| --- | ---: | --- |
| 通用安全智能体底座 | 约 90% | 仓库内调度、证据、执行、Provider、数据化 Scenario 及资源装配主链已收口，可进入首个真实场景接入；真实模型、原生平台矩阵和长稳仍是外部发布验收，不能按代码完成冒充生产验收 |
| 单机生产化能力 | 约 71% | 已具备持久化、门禁、Execution Node、Provider 生命周期与受控分发；执行异常查询、可信凭据核验、对账和授权重试已连通，并通过选定跨进程强杀窗口；Windows 实机隔离、容量与长稳验收仍未完成，不按新增接口数量上调完成度 |
| Web 黑盒实战场景 | 约 60% | 签名数据包和独立进程已接入；结构化同源探索、断点续跑、网络回执—Artifact—Evidence 关联、受控认证会话、秘密句柄和按 Run 脱敏流量历史已闭环；业务流程/身份差异建模、受控浏览器和完整验证策略仍未完成 |
| 白盒代码审计场景 | 尚未正式开发 | 只复用底座，不在当前开发主线上加入 AST、污点规则等场景工具 |
| 红队内网横向场景 | 尚未正式开发 | PTY、隧道、长期远程会话和高风险审批策略仍待后续装配 |

这些百分比是按目标能力和生产验收项估算，不是按代码行数或测试覆盖率计算。

当前最准确的产品定位是：TraceForge 已经是一套可运行、可持久化、可恢复、具备安全执行主链的
Security Agent Runtime，并进入底座生产化阶段；Core、Agent Runtime、Scenario SDK 和通用 Foundation
已不再持有 Web Session/Traffic/Cookie/HTTP/Browser Contract；产品入口也已改为读取通用本机审核安装配置，缺省不安装任何场景。

关键能力的实际状态如下：

| 能力 | 当前状态 |
| --- | --- |
| Event-sourced Run、Work/Lease/Checkpoint/Recovery | 已实现 |
| Planner、Observer、Worker Loop | 已实现 |
| Evidence Graph、Finding 生命周期门禁 | 已实现 |
| Cognitive Snapshot、Model Runtime、预算与并发准入 | 已实现 |
| Capability Registry、Tool Discovery、Risk/Permission Gateway | 已实现 |
| Managed Provider、签名/哈希、generation draining | 生产主链已实现 |
| Skills/Knowledge/MCP/Provider 统一扩展装配 | 当前选择的精确身份、Package 绑定、运行期撤销、整代回退、Provider 生命周期对账、Package Process 启动摘要、活动代切换恢复和有界压缩历史归档已实现；Scenario Package 已可从审核材料的纯数据描述文件装配，本地 Skill/Knowledge/迁移正文自动进入既有存储，外部 MCP 继续绑定宿主 Profile；可分发的混合扩展包安装与签名轮换尚未实现 |
| Execution Node RPC、Scope 再授权、Brokered HTTP | 本机主链、五类逐操作永久账本及透明归档、容量健康、helper 发布清单、结构化启动预检、运行中摘要健康检查和有界全进程树关闭已实现；Linux framed PTY 已接生产代码和 19 类验收入口，协议 2 的 Linux 实机重跑与 Windows 双模式实机证明仍是发布门槛。远程 TLS/节点/跨主机装配已撤回；桌面软件更新系统按用户要求暂缓 |
| Scope 策略版本固定与升级 | 新授权精确绑定、统一策略读取、生产派发复检、历史显式确认、保守兼容升级及原子恢复已实现；语义变化的旧 Run 改绑未实现 |
| Scenario 审核材料与受信装配 | 本地入口/依赖清单、Ed25519 审核、不可变版本登记、当前信任复检及独立撤销审计已实现；纯数据 `scenario.json` 可提供自动来源关联，手工旧对象仍须可信宿主确认；不是下载器或任意 JS 沙箱 |
| 失信包下旧 Run 处置 | 无包依赖取证/分页、独立授权停止、当前占用核对、退役回执、生产取消和原子/强杀恢复已实现，并接入有界快照与冷热回读；不删除历史、不自动清理未知动作，超大状态和任意长度历史仍有限制 |
| Run 长历史快照与归档 | 连续前缀原件压缩、版本化状态快照、当前完整性校验、冷热分页、命令幂等/租约索引、生产恢复和强杀原子性已实现；冷正文仍在同一 SQLite，已纳入一致灾难备份，但未交付独立冷对象库，校验成本仍随压缩历史增长 |
| 底座备份与灾难恢复 | 一致备份、加密签名离线介质、默认法证保留/精确销毁、隔离恢复和永久只读取证围栏已实现；六类依赖核对、独立候选工作库、当前材料重新装配、活动指针启动、相邻候选回退及切换强杀恢复已接生产控制面；旧 Run 默认暂停且不重放，真实异地介质、密钥轮换/恢复、断电及 Windows 切换演练未完成 |
| Windows 可证明执行约束 | 约束、Job 清理屏障、watchdog 与持久化启动身份已实现；未完成 Windows 双模式实机验收，未启用原生可信清理签发者 |
| Scenario 插件化、零场景运行 | 独立 SDK、空 Registry、Run 版本固定、资源 Contract、显式版本迁移、生产工具强制 Scenario Process、声明式授权/输出/证据合同和签名数据描述文件加载已实现；应用入口已取消 Web 硬编码并从本机审核配置装配，附带离线打包签名命令；显式词法资源前缀可表达场景预先规范化的授权命名空间，但底座不解释 URL/路径语义；任意结构转换、自动排空和分发市场未完成 |
| Provider-to-Host 反向能力 Broker | 底座主链已实现：Core、双向 RPC、持久化授权、可选 Host Registry 和中性真实子进程验收通过；具体能力 Adapter 冻结到场景阶段 |
| Tool Provider 恢复与隔离 | 主链、七类记录逻辑容量、v2 精确续跑、受控归档/回读已实现；物理空间准入、WAL 维护、授权快照迁移/清理与连续组合验收入口已交付；真实 24/72 小时长稳、全卷容量、永久键扩展和平台发布验收仍未完成 |
| 受控执行来源外部占用 | 默认 Managed Provider、内置进程、MCP 和显式注册的自定义来源/Scenario Process 共享配额与重启围栏；生产 Scenario 工具工厂和授权/输出回调均在调用前拒绝，开发兼容须分别显式 opt-in；原生可信签发仍关闭 |
| 单用户宿主管理/Worker 通道 | 生产默认能力票据门禁、Worker/定义/租约绑定、撤销/轮换/重启失效及 Desktop Main 的精确 loopback API/WS 注入已实现；旧匿名 API 不兼容，打包后 Electron 人工冒烟尚未执行；不是多用户账号系统、远程管理系统或同进程 JS 沙箱 |
| 上下文资源包迁移 | context-only 完整资源清单的 Ed25519 导出/导入、原子发布、授权审计与持续信任校验已接生产宿主；目标须已有匹配契约，混合资产/可执行 Scenario 迁移未实现 |
| Linux 可证明沙箱后端 | 原生 Rust Helper、构建/发布门禁、严格探测/measurement/enforcement Contract、stdio 与 framed PTY 生产路径已完成；Ubuntu 24.04 x64 的协议 1/16 类历史验收保留，当前协议 2/19 类矩阵尚待 Linux 实机重跑。其他 Linux 平台矩阵、独立可信报告签发与正式安全审计仍未完成，失败时无普通进程回退 |
| Brokered Browser Runtime | 通用 Core、Host/进程双向控制协议、Chromium CDP 策略、真实 FD 3/4 pipe、DOM/截图 Artifact、稳定引用、有界动作、人工接管恢复、可复现 Controller bundle、macOS arm64 Chrome 152 真实全链、官方源码 Build Attestation、Source Lock、离线 Ed25519 评审权威、安全解压和 v3 完整安装树门禁已实现；仍缺实际 Chromium 双构建、真实 SBOM/NOTICE 与评估、各平台锁定产物及 Linux/Windows 原生“不走 Broker 无法联网”证明，生产能力继续关闭 |
| 多节点调度、统一运维控制台 | 远程 Execution Node 与多节点调度已排除出当前产品范围；统一运维 UI 不在当前底座开发范围 |

目标依赖方向按六层约束，依赖只能向下指向 Contract，底层不得反向认识 Application：

```text
Application / Scenario Packages
            ↓
Cognitive / Agent Runtime
            ↓
Orchestration Runtime
            ↓
Knowledge / State Runtime
            ↓
Capability / Tool Runtime
            ↓
Security Execution Runtime
```

这不是要求立即拆成六个同名包，而是用于判断职责与 import 方向。包拆分必须服务于可替换、可测试和
多宿主复用，不能为了目录对称制造新的抽象层。

## 3. 已经落地的底座能力

### 3.1 黑板协作与调度

- Scenario Profile 定义场景目标、执行阶段、Worker 拓扑、能力需求和授权动作。
- Planner 负责基于 Hypothesis、Evidence 和覆盖缺口产生、取消或调整 Work。
- 全局 Observer 独立订阅 Run 与 Evidence Graph 变化，可继续、纠偏、终止分支或终止 Run。
- Worker 使用能力匹配、租约、心跳、幂等键、检查点、重试和过期回收机制执行 Work。
- 同一 Run 可保留多个假设和排队任务，但一次只允许一个验证任务拥有执行权。
- SQLite 事件存储是当前单机黑板事实来源，进程内事件总线负责低延迟唤醒，定时扫描只承担恢复职责。
- `ScenarioKind`、Work/Role/Output 身份已经改为开放字符串，Work 默认角色、同类并发上限、Hypothesis
  引用下限和完成输出要求由 Definition 声明，Core 不再解释 `validation` 等具体工作语义。
- `web_blackbox` 的新版数据描述、阶段、Worker 拓扑、声明式授权/输出、Skill、Knowledge 和进程工具位于
  `scenarios/web-blackbox`。独立 `scenario-sdk` 只暴露通用 Package、Authorization、Evidence、Capability Registry
  和 Governed Execution 装配端口；通用 Foundation 与产品入口均不知道 Web 场景常量。场景进程只能申请 Package 明确声明且宿主提供的通用授权、
  Execution Node 受控 HTTP、Artifact、State、Evidence、Session 和 Traffic；旧同进程 Web 工厂、direct Browser 工具及其生产依赖已经删除，控制面回归只使用无网络测试 fixture。

### 3.2 统一证据图谱

- 已实现通用 Knowledge/Evidence Graph，支持实体、事实、假设、证据、任务、验证结论、发现和限制节点。
- 图变更使用预期 revision、幂等 command id 和不可变事件，避免并发覆盖。
- Finding 不能由单一工具成功直接验证；验证要求可追溯证据、因果机制、影响和合法生命周期转换。
- Worker 工具只能引用持久化 Tool Receipt、Traffic 或 Artifact 作为证据来源。

### 3.3 上下文、模型与认知快照

- Planner、Observer、Worker 共用确定性的上下文蒸馏器。
- 原始工具输出和图谱状态留在持久化存储，模型只接收有界摘要、差异、引用和省略计数。
- 每次模型调用前保存实际 System Instruction、用户载荷、JSON Schema、Run/Graph revision 和上下文 manifest。
- Model Runtime 已具备角色路由、超时、重试、熔断、每 Run Token 预算、并发准入、队列优先级和调用审计。
- Scenario Agent Protocol V2 已统一 Turn、Item、工具调用、审批和控制面事件，支持持久化重放和 WebSocket 增量同步。

### 3.4 安全执行与会话

- Execution Node RPC 负责受归属信息约束的进程、文件系统和 Brokered HTTP 执行。
- 进程执行要求 CPU、内存、子进程数和写入字节配额，并验证权限与资源指纹证明。
- Windows 原生后端采用受限令牌、Job Object、私有桌面和按网络策略使用 AppContainer；缺少可验证后端时进程能力关闭，不直连回退。
- Web HTTP 请求经过 Scope Guard 重新授权、网络 Broker、大小/超时限制和持久化 Network Receipt。
- Execution Identity、加密 Vault、Cookie/Session 状态、撤销冻结和租约归属已经接入。
- 高风险动作使用持久化检查点和审批挂起，批准后按原 Work 恢复。

### 3.5 Security Tool Runtime V2

- 工具以带来源、版本、能力、依赖、优先级、风险和权限要求的 Provider 注册，不再使用固定工具数组。
- Work 能力需求经过 Worker 能力、Scenario 权限和风险策略求交，只向模型暴露最小工具集合。
- 注册表支持动态发现、版本替换、排空、退休、健康降级、备用 Provider 和失败阈值。
- 所有弹性 Worker 共享同一个工具注册表与 Provider 健康状态。
- 外部 Provider 使用版本化长度前缀 stdio RPC，支持握手、发现、调用、崩溃重启和关闭回收。
- 生产 Provider 可通过 Execution Node 启动。RPC 握手前必须验证真实的沙箱、文件权限、资源配额、网络策略及其指纹证明。
- Provider 禁止 direct 网络、明文密钥和非沙箱进程权限；事件丢失、输出截断、资源超限或租约过期会立即使其失效。
- `GET /api/security-tools/runtime` 提供不含执行实现和秘密数据的运行状态。
- 已加入持久化 Provider Manifest 初始控制面：Ed25519 本地信任根、规范化签名载荷、
  可执行文件与完整包 SHA-256、签名工具目录、平台/协议/权限/资源声明、版本状态、幂等命令和不可变审计事件。
- 已提供安装、启用、排空、禁用、隔离、显式回滚、目录查询和事件查询 API；启动时只尝试
  恢复持久化为 enabled 的版本，签名、文件或运行来源验证失败会转为 failed。
- 安装源通过受限遍历复制到只读托管目录，经复制后复验再原子发布；符号链接、特殊文件、
  文件/字节超限、导入期间变更和目标内容冲突均会拒绝。
- 默认生产来源只从签名 Manifest 发现工具；每次调用按真实 Case/Run/Work/Worker/lease/scope
  归属独立通过 Execution Node 启动，握手身份和版本必须与签名 Manifest 一致。
- 版本切换先发布新目录并停止旧 generation 接收调用，随后原子持久化新版本 `enabled` 与旧版本
  `draining`；旧调用归零后才关闭旧来源并转为 `disabled`。同一 Provider 的生命周期命令串行执行。
- 启动恢复只恢复持久化的 enabled 版本；中断的 draining generation 不跨主进程继承执行所有权，
  会通过审计事件确定性对账为 disabled。

### 3.6 已清理的旧架构

- 旧聊天式 AgentRun/AgentEvent、旧 Solver、旧 BrowserSession 和 Burp 桥接已经删除。
- 不保留旧对象兼容层，数据库启动时清理相应旧表。
- TraceForge 独立启动和运行，不依赖 Codex 应用、CLI 或配置。

## 4. 当前尚未达到生产要求的部分

### 4.1 Scenario 已从 Core/Foundation 与应用组合根抽离

第一段抽离已经完成：`orchestration-core` 不再声明具体 Scenario/Work/Role/Output 枚举，也不再包含或导出
Web Definition；Scenario Definition Registry 可以为空，路由 Definition Catalog 在未安装场景时返回空列表，
Server Foundation 接受外部 Definition 清单，产品入口在没有审核安装配置时保持空 Catalog。

第二段抽离也已完成：Foundation 接受显式 `ScenarioPackageInstallation`，Package Registry 汇总 Definition、
Authorization Policy 和 Tool Discovery Source；通用 Embedded Worker 只装配 Knowledge/Execution 平台工具和外部
传入的场景来源，不再 import 或默认构造 Web 工具。空 Package Registry 不产生任何场景 Definition 或场景工具。

第三段授权边界也已完成：通用 `ScenarioAuthorizationPort` 负责按 Envelope 归属加载授权，Package Policy
负责解析不透明 Scope、动作集合和具体资源；Execution Node 只提交 `resourceKind + value`，不再直接认识 URL、
Web Guard 或 Web 黑盒。中性 Scope/资源测试证明该服务可以处理非 URL 资源。

第四段物理边界已经完成：`ScenarioPackageInstallation/Registry` 与通用授权、证据、Artifact、State 和进程能力进入独立
`@traceforge/scenario-sdk`；Web 专属定义、工具、Skill 和 Knowledge 留在 Web 包。Scenario 包不再 import Server 类型或直接访问 SQLite。

第五段版本绑定已经完成：新 Run 在事件事实和 SQLite 投影中同时持久化 Package id/version/schema revision；
Runtime、Routes 和 Embedded Worker 在加载或执行前验证准确绑定。缺包、Schema revision 不匹配或历史 Run
缺少绑定时返回 `recovery_required` 诊断，不会静默套用当前安装版本；旧数据库只增加 nullable 字段，不伪造绑定。

第六段输出与证据边界已经完成：Package 注册版本化 Output Schema，Registry 在安装时确认 Definition 引用的
输出类型都有 Schema；生产完成路径在写入 Run Event 前由当前绑定包校验，Event 持久化 schema version，随后通过
通用 `ScenarioEvidencePort` 幂等映射到 Evidence Graph。Web 的输出类型和映射规则只存在于 Web 包，Server 只提供
Evidence Graph Adapter，Core 仍只处理通用 Output Envelope。

通用场景资源装配与生命周期控制已形成生产调用路径：数据描述包可自动安装受信本地 Skill、Knowledge 和 migration
正文，外部 MCP 通过宿主 Profile 绑定；保留状态的显式包迁移已实现。自动排空及任意状态转换仍未实现。新增取证、恶意代码分析、
云安全或移动审计可能需要新的通用宿主能力端口，但不再需要修改 Core、通用 Foundation、通用 Routes、
Embedded Worker 默认工具数组或 Execution Node Service。

应用组合根迁移也已完成：`apps/server/src/main.ts` 只读取严格的 `config/scenarios.json`，由审核材料构造数据 Package 并绑定本机
Scenario Process Profile，不再引用 Web 包或创建 Web 专属 Host Adapter。Web `0.3.0` 已证明数据化场景、结构化探索与受控认证链可用；旧 `0.1.0`
同进程工厂暂留在场景工程用于历史回归，不进入生产入口。不得继续向 Core、通用 Server 或默认 builtin tool source 增加任何场景名称、
能力、阶段、角色、输出类型、Prompt、工具或授权动作。审查清单见 [通用安全智能体底座完成度审查](architecture/foundation-completion-audit.md)。

### 4.2 Tool Provider 控制面仍需完成生产化后半段

签名 Manifest、信任根、文件/包哈希、只读原子目录发布、持久化生命周期、控制 API、显式回滚、
启动恢复和按调用归属的生产托管来源工厂已经落地。调用级 Contract Binding、原子 Admission Fence、
通用 Work/Run 终态释放、Provider 日志审计隔离与 detail 保留/授权查询治理、公平配额和升级兼容治理也已完成。
安装包和调用暂存目录的所有权感知垃圾回收也已落地。确定性 `.tfpa` 归档、安全解包库、离线签名发布命令及
受授权的流式上传/安装与显式刷新 API 已经完成；应用级提交/文件系统故障注入、归档安装跨进程崩溃恢复、激活交付准入重试与
补偿失败关闭准入已覆盖。启用/升级/回滚的宿主强杀、目录与准入恢复已补充；有真实调用在途时的宿主故障、持续存储故障等
调用声明、未知结果阻断、回执对账及真实调用宿主强杀的软件验收已补充。未知结果的授权对账 Contract、控制 API、默认拒绝授权、
可信证据验证端口、不可变审计和安全释放已完成。具体部署的执行节点/外部系统证明器、任意残留进程的自动可信清理、
持续存储故障及真实平台隔离验收仍未完成，不能将软件夹具或可注入 Contract 等同于全平台生产保证。

### 4.3 反向能力 Broker 已完成底座主链，场景 Adapter 开始接入

Provider 进程现在必须使用固定的最小 OS 权限。通用 Broker Core、双向 RPC、持久化 Receipt、授权组合和
可选 Host Registry 已实现；零 Handler/Policy 时 Host 不创建，反向方法不对 Provider 开放。中性真实 Provider
子进程已经穿过 Managed Provider Source、Execution Node、Host Registry、授权和 SQLite Receipt，并验证重启
replay 与关闭后的迟到响应隔离。Scenario Process 侧已经接入通用授权、Artifact、State、Evidence、Session、Traffic 与 Execution Node HTTP 桥接；
首个 Web 包已通过这些端口保存结构化探索状态、使用 Vault 内秘密句柄和 Cookie Jar，并关联脱敏流量、网络回执、工件和证据。Managed Provider 的文件或浏览器 Adapter 仍未注册，后续只有真实场景需要时才按
最小能力装配，不能把场景能力变成全局默认。

### 4.4 Browser Runtime 真实本机链已通过，等待正式发行物与原生隔离验收

`@traceforge/browser-runtime` 已把 Browser Process 固定为 Execution Node 启动且 OS `network=deny`，并要求 Controller 在开放请求前证明 pipe、联网前暂停、Service Worker 禁用和下载/WebSocket 拦截。Host 侧 Controller 已通过 Execution Node stdin/stdout 实现有界长度帧、审核身份/版本/摘要握手、激活门禁、稳定控制操作 ID、事件丢失/截断/进程退出失败关闭和迟到响应隔离。navigation、redirect、popup、iframe、fetch/XHR 与 download 分别复检所有权和网络授权后，才由 Host 调用现有 HTTP Broker；WebSocket 在流式 Broker 完成前阻断。macOS arm64 Chrome 152 已真实跑通 pipe、302 redirect、popup、同进程 iframe、页面请求、下载、DOM/截图/动作、人工接管恢复、renderer crash 和 bundle 正常关闭，并据此修复 iframe 误分类与 shutdown 悬挂。v3 发布身份同时核对官方源码 Build Attestation、离线评审、Controller、Chromium 启动文件和完整安装树，原子装配拒绝覆盖已有目录且复制前后必须同摘要。当前缺口是实际完成固定 Chromium commit 的独立双构建、真实安全/许可证材料和各平台可再分发 release tree，并在 Linux/Windows 真机证明 Browser Process 无法绕过 Broker 联网；这些验收完成前 Browser Provider 仍关闭。

### 4.5 Web 黑盒的场景认知策略还不完整

当前 Package 已具备有界 URL 规范化、同源链接发现、去重队列、逐 URL 授权、HTTP 摘要、断点续跑、受控认证会话、秘密正文构造、短期值捕获及 Network Receipt—Traffic—Artifact—Evidence 关联。仍缺少页面状态覆盖、身份矩阵、业务流程状态机、参数与数据关系学习、验证矩阵、受控外带回调和最终覆盖评估。任意 JavaScript 登录、OAuth/OIDC、MFA 及人工接管也尚未支持。具体 Payload 和漏洞知识应放入 Web Scenario 工具/知识包，不进入通用底座。

### 4.6 运维与可靠性仍需补齐

- 工具、Worker、Planner、Observer、模型预算和执行节点虽有 API/事件，但缺少统一运维控制台。
- 缺少长时间运行、断电恢复、磁盘耗尽、Provider 频繁崩溃、模型供应商波动和高并发任务的系统级验证。
- 当前明确采用单用户、单宿主 SQLite；不建设多节点 Worker、跨主机队列和远程数据库拓扑。
- Linux 原生执行已在 Ubuntu 24.04 x64 打通，仍缺其他发行版/内核矩阵、安装升级回滚和独立可信报告签发。
- 凭据实体可以进入受权限控制的黑板，但面向操作者的查看、脱敏、授权与审计体验还未完成闭环。

### 4.7 `apps/server` 同时承担 API、组合根和大量 Runtime 实现

当前 `apps/server` 仍不只是 Fastify Adapter：Planner/Observer 的通用决策监督、Model Runtime/Admission 和上下文血缘投影已迁入 packages，
Structured Worker Model 也已迁入 Cognitive Runtime，但 Hypothesis 与 Artifact 调度、Evidence Store、Execution Session 和 Provider Control Plane 的大量实现仍位于其中；
而 `packages/reasoning-core` 相对较薄。这会迫使未来 Desktop、CLI 或其他本机组合入口依赖 Server 内部代码，
也让 Application、Runtime、Persistence Adapter 与 Transport 边界难以验证。

这一问题不能通过按文件数量机械拆包解决。应先完成 Scenario Contract 和依赖方向，再按稳定职责逐步提取
可独立测试的 Runtime；Fastify 路由、WebSocket、配置加载、SQLite 适配和 Composition Root 留在 Server，
领域状态机与不依赖传输/数据库实现的 Runtime 移入 packages。

## 5. 接下来的开发计划

以下顺序按生产依赖关系排列，不是原型阶段划分。

### 当前开发边界：底座冻结，具体场景通过 Package 边界推进

交付节奏：后续按完整底座能力批次推进，将状态模型、生产接线、故障/并发回归、完整门禁与计划同步合并交付，
不再每补一个小故障点就要求用户回复“继续”。必要授权、架构选择或真实外部环境缺失时才暂停并说明。

通用底座的仓库主链已经收口并冻结，当前只接受真实 Scenario Package 接入暴露出的通用边界缺陷；不得为了某个场景把
URL、协议、漏洞类型、状态码、工具或策略硬编码回 Core/Foundation。具体能力在独立 Package 进程、Skill、Knowledge 和
宿主显式能力内推进；应用 UI、远程节点、多用户和桌面更新不属于当前开发范围。Browser 仍按自身强制代理与原生隔离门槛关闭。

当前实际执行队列：

1. ~~完成零场景底座构建/测试门禁、开放标识符校验和中性 Scenario Contract fixture。~~ 已完成。
2. ~~依赖图、Model Runtime、workspace 循环拆除以及 Cognitive 上下文/快照/评估/唤醒/循环调度提取。~~ 已完成。
3. ~~Provider-to-Host Capability Broker。~~ 底座主链与中性生产组合验收已完成。
4. ~~Tool Runtime 的恢复、隔离和故障治理。~~ 主链、可信回执、授权重试/精确续跑、归档/回读、物理空间门禁、授权存储维护及组合压力入口已完成；真实 24/72 小时长稳、完整生产宿主负载、永久键规模扩展和平台验收仍是发布门槛。
5. ~~Provider 归档分发、签名工具、持久化调用回执与旧包回收。~~ 已完成；真实平台断电、持续存储故障和全平台清理证明仍属于发布验收。
6. Linux 可证明执行后端的仓库实现已完成；协议 2/19 类 Linux 实机重跑与 Windows 双模式仍是外部发布门槛，证明缺失时能力继续关闭。
7. ~~底座长期运行可靠性、Codex 通用 Runtime 机制吸收及仓库完成度审查。~~ 仓库主链已收口；真实模型、24/72 小时长稳和原生平台矩阵按既定口径保留为外部发布验收，不再继续堆叠没有真实调用路径的控制层。
8. ~~**首个真实安全 Scenario Package 接入。**~~ Web 黑盒已从应用入口硬编码对象迁到审核目录中的 `scenario.json`、Scenario Process、Skill/Knowledge 与宿主 Profile 装配；缺省保持零场景。
9. **当前阶段：Brokered Browser Runtime 正式发行门禁。** 通用 Core、Host/进程协议、Chromium CDP 策略、真实 pipe、页面能力、人工接管、可复现 Controller、macOS 真实 Chrome 全链、官方源码 Build Attestation 和整树身份/原子装配已经完成；下一整批在可用构建环境上执行固定 Chromium commit 的独立双构建并生成真实 SBOM/NOTICE、安全/许可证评估和平台签名产物。Linux/Windows 原生隔离证明仍等待可用真机，期间不引入远程执行节点；不提供 direct Browser 临时版，也不提前开发应用 UI 或 Web Scenario 适配。

同一优先级内只允许并行处理依赖方向已经稳定、不会扩大场景耦合的工作；不得以“并行开发”为由
绕过底座冻结边界。场景的端到端效果可以驱动 Package 自身演进，但不能直接变成底座领域规则。

### Codex 可参考机制的纳入原则（仅用于网络安全智能体底座）

这部分是对底座开发的实现参考，不是把 TraceForge 改造成 Codex，也不是声明 TraceForge 复用了 Codex
源码。参考对象是 OpenAI Codex 的公开实现：
[`protocol.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)、
[`items.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs)、
[`orchestrator.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/orchestrator.rs)、
[`process.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process.rs)、
[`process_manager.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs)
和 [`compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)。长时工具链需要主动治理上下文，
这一方向也与 [OpenAI 官方模型指导中的 compaction 说明](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5)
一致。

| Codex 中值得参考的底层机制 | TraceForge 当前对应物与实际缺口 | 纳入本计划的底座落地方式 | 明确不照搬的部分 |
| --- | --- | --- | --- |
| **Typed Turn/Item 生命周期和 SQ/EQ 式事件消费**：把一轮执行、工具调用、输出和压缩都作为可识别的生命周期项，而不是让客户端解析终端日志。 | `SqliteScenarioAgentEventStream` 已按 Run 持久化 `turn/*`、`item/*` 和有序序列；仍需把线协议、持久化事件、重放游标和版本兼容统一成一个可验证 Contract。 | 在现有 Scenario Agent Protocol V2 上补充版本化 codec、重放 cursor、重复/乱序/断点续传测试，并为 `context_compaction` 增加通用生命周期项。所有事件继续保留 Run/Case/Work 归属和 SQLite 事实来源。 | 不采用 Codex 的 session/SQ/EQ 作为 TraceForge 的持久化真相，不引入 coding task、terminal log 或 OpenAI 专属字段到 Core。
| **集中式 Tool Orchestrator**：在工具真正执行前统一处理审批、沙箱/网络策略、执行上下文和可重试结果。 | `PolicyExecutionToolGateway`、`ScenarioAuthorizationPort` 和 Execution Node 已形成门禁；超时/Provider 异常会进入 uncertain/recovery，但取消、审批等待、对账和重试的跨层结果仍需更统一。 | 在 Tool Runtime 中定义通用 execution decision/result 状态：`approval_required`、`admitted`、`executing`、`uncertain`、`reconcile_required`、`retry_allowed`、`rejected`；把 Gateway、Provider、Execution Node 的状态映射到同一审计链。只有可信对账证明无副作用时才允许重试。 | 不复制 Codex 的命令型沙箱选择、网络批准交互或“换沙箱再试”的默认策略；网络安全动作必须服从当前 Scenario Package 的授权 Envelope，未知副作用默认阻断。
| **显式进程生命周期、取消和有界输出**：进程句柄、取消令牌、任务结束通知和输出截断由执行运行时统一管理。 | 已接通 Gateway `AbortSignal` → `ExecutionNodeProcessTool` → 显式终止请求，覆盖迟到启动响应和输入/观察期间取消；已加入进程历史内存上限、journal 预留配额及安全裁剪。Run 用户取消、暂停、Scope 撤销和执行权核对已接入 Worker/Gateway 信号链；终止后有界等待终态，仍不等于独立可信清理。 | 后续统一事件与恢复读取语义；未知外部结果不能解除 Invocation 围栏。补充 head/tail 输出摘要、原始输出哈希、截断原因和 Artifact 引用，确保恢复时不重派旧幂等键。 | 不把 Codex 的内存进程表、PTY 或本地 ExecServer 当作安全事实来源；TraceForge 的进程所有权、清理结果和调用归属必须以持久化账本和可验证证明为准，也不默认开启普通进程回退。
| **语义化上下文压缩和压缩生命周期**：压缩前后有明确生命周期、失败恢复和可观察记录。 | 已接入三角色授权来源投影、通用 `ContextCompactionRuntime`、compaction manifest、SQLite 生命周期及重启恢复；默认首尾摘录，不是语义总结。保留本次供应的结构身份，recentEvents 仍有窗口限制。缓存状态与实际模型输入 manifest 已作为独立审计事实接入共享协议和只读引用。 | 后续验收真实语义质量及长期归档/规模扩展；当前失败回退安全原投影，相同失败身份不后台重试。摘要只能作为模型输入，不能替代原始证据或改变 Evidence Graph；轮询不保证采集全部短暂状态。 | 不复制 Codex 的 coding history、prompt、hook 或 provider 专属 compaction 文本；不得让模型摘要直接验证发现、改变授权或覆盖持久化事件。
| **Head/tail 保留和长时恢复思路**：在输出和上下文达到上限时保留两端可定位信息，并给出明确的省略/截断标记。 | TraceForge 已对工具输出做哈希和长度限制，但不同 Runtime 的保留策略和容量拒绝行为还未完全统一。 | 将输出、事件、诊断和压缩历史纳入同一 Retention/Capacity Policy：先保护未决调用、审批、Evidence 引用和恢复凭据，再按策略裁剪可重建数据；达到硬上限时明确拒绝新增操作，不删除用来解除卡住的记录。 | 不把截断后的文本当完整事实，不以删除历史来“解决”容量问题，不在底座中加入某个漏洞、协议或目标的保留规则。

#### 落地顺序与验收合并方式

以下是最初的里程碑分解；已落地部分由后续批次记录承接，当前优先级以第 7 节为准，不将每个条目拆成孤立小交付：

1. **先打通取消与进程观察**：验证 Gateway 超时、用户取消、租约过期和 Provider 崩溃都能让真实执行进入可查询终态；未确认终态前不释放名额、不允许重派。
2. **再接入语义压缩 Contract**：在快照、事件流和上下文蒸馏之间建立可恢复的压缩记录；重复重启、压缩失败或存储写失败时保留原始证据并进入 recovery-required。
3. **同时收紧事件与输出容量治理**：统一有界历史、head/tail 摘要、哈希和省略清单；重复/乱序事件、达到上限和部分成功 Work 都必须有确定性拒绝或续跑结果。
4. **最后做组合验收**：连续运行、反复重启、底层强杀、磁盘写失败、Provider 波动和容量上限组合执行，证明“不重复外部动作、不丢已确认结果、无法安全恢复时明确阻断”。

2026-08-30 落地进展：本次交付完成“执行取消与进程历史容量”这一端到端子能力，包含生产接线、SQLite 迁移、
保留策略、只读分页及故障/重启测试；不是仅增加 Contract。上述四项组成的长期可靠性里程碑仍未全部完成，
不能把这个子能力的完成状态扩展为语义压缩、全局存储治理或部分成功 Work 已可续跑。

这批工作完成后，Codex 参考项的价值是沉淀为 TraceForge 自己的通用 Runtime Contract；仍不改变“Core 不认识 Application/Scenario，具体适配留到后续场景阶段”的总边界。

通俗作用：借鉴 Codex 后，底座会更像一个“有账本、有暂停键、有安全压缩功能的长期运行系统”——工具超时或进程被杀时能确认到底停没停，历史太长时能压缩但不丢证据，恢复时知道哪些动作已经做过，容量到顶时会明确停下来，而不是悄悄重复执行或把关键记录删掉。

#### 面向后续网络安全场景的实际复用映射

Codex 只提供可借鉴的 Runtime 机制，不能提供 TraceForge 的漏洞判断、攻击策略或授权结论。底座完成后，未来的
Scenario Package 应按下表复用这些机制；当前阶段只做通用 Contract 和中性验收，不提前开发场景逻辑。

| 底座参考机制 | Web 黑盒后续价值 | 白盒代码审计后续价值 | 红队内网/横向后续价值 |
| --- | --- | --- | --- |
| Typed Turn/Item 生命周期、可重放事件 | 将请求、响应、页面状态、身份切换和验证结论串成可回放证据链。 | 将仓库快照、分析步骤、Source/Sink 路径、修复验证和报告引用串成可追溯链。 | 将凭据使用、跳板、隧道、远程命令和人工批准串成可审计链，支持中断后续接。 |
| 集中式 Orchestrator、审批和对账 | 高风险请求、外带回调、状态修改等动作先过 Scope/Approval；未知结果不自动重放。 | 读取敏感文件、运行构建/测试或生成 PoC 时保留授权边界和副作用确认。 | 横向移动、凭据尝试、远程执行和隧道建立必须逐动作授权，失败时按租约和证据对账。 |
| 进程生命周期、取消、终态观察 | 浏览器、代理、扫描器超时后确保真实进程和网络会话停止，不留下孤儿任务。 | AST/索引/编译分析被取消或宿主重启后可安全恢复，不重复昂贵或有副作用的步骤。 | PTY、跳板和长期会话断开后能确认清理结果，不能凭旧 PID 继续接管未知进程。 |
| 语义上下文压缩、快照和 lineage | 长流程探索压缩后仍保留目标、身份、假设、证据引用和未覆盖面。 | 大型仓库分析压缩后仍保留文件版本、路径定位、分析结论和待验证假设。 | 拓扑、会话、凭据和已执行动作压缩后仍保留归属、审批和未决风险。 |
| Head/tail 输出、哈希、容量策略 | 大响应、流量和截图摘要有界，但仍能定位原始 Artifact 和完整性指纹。 | 编译日志、规则命中、代码片段和差异输出有界，原文通过受控 Artifact 引用保存。 | 命令输出、网络日志和会话记录达到上限时明确阻断，不以删审计记录换取继续执行。 |

场景接入验收要求：每个后续安全场景都必须证明“同一套 Runtime 机制 + 自己的授权/工具/输出 Schema”即可运行；
不得为了 Web、代码审计或横向移动把 Payload、漏洞类型、URL 规则、仓库语义、凭据动作或 PTY 规则写回 Core。
Codex 的默认行为若与安全底座的 fail-closed、证据完整性、执行归属或不可重复副作用要求冲突，以 TraceForge 的安全
Contract 为准。

### Skills、知识库与 MCP 的底座归属（按当前源码核对）

这三类能力都与安全智能体有关，但只有“通用机制”属于底座；具体技能内容、知识内容和外部服务实例不能写进 Core。
当前已完成版本化 Skill/知识文本的受控按需读取、Skill 输入/输出与机械完成条件检查，以及 MCP Tools 和固定 Resources/Prompts 文本到 Worker 的受控接线；
这不等于完整 Skill 语义评估、语义知识库或全量 MCP 协议已完成。具体边界见
`docs/architecture/context-and-mcp-assembly.md`。

| 对象 | 当前实际位置与状态 | 属于底座的部分 | 留给后续安全场景/部署包的部分 |
| --- | --- | --- | --- |
| **Skills（技能/Playbook）** | SDK 显式 Skill 资源已有摘要、授权、能力、阶段、引用与独立有界输入/输出契约；Gateway `context.skill.prepare/evaluate` 以同 Work 准备回执、精确版本和机械条件检查完成度。没有自动脚本执行。 | 指令资源装配、契约校验、回执溯源、历史过滤和发送前复查已接线；未实现语义评分或独立技能执行调度器。通过契约不等于发现已验证，不得绕过 Gateway。 | Web 资产发现、身份矩阵、代码 Source/Sink 分析等具体 Playbook、Prompt、模板和 Payload 留在 Scenario Package，不能由 Core 解释。
| **知识库** | Evidence Graph/共享知识机制保留；`context.type=knowledge` 现可安装版本化文本、授权发现、分页读取，来源随回执/检查点/模型快照保存。已有按包/权限的有界字面检索、有效期/冲突筛选和 Worker 历史过滤；尚无语义索引、外部自动同步或语义压缩。 | Evidence Graph、Retriever/Indexer、来源/版本/新鲜度/冲突、授权、引用和注入审计属于底座；文本不得自动升级成可信事实或验证结论。 | CWE/OWASP 映射、HTTP/身份/业务流程知识、AST 规则、网络拓扑和工具说明等内容及适配器，仍由版本化知识包提供。
| **MCP** | `mcpServers` 提供受控 Tools；`mcpContextServers` 提供精确 profile/URI/参数/digest 的文本 Resources/Prompts，经 `context.read` 及 Execution Node 独立进程接入回执/撤销/恢复。旧 extension stdio 仍仅为开发兼容。 | 固定 Tools 与上下文子集闭环已接线；远程 HTTP、资源模板、动态参数、目录分页、订阅/热更新和原生平台实机验收未完成。没有隔离证明就拒绝，远端 Prompt 不成为系统指令。 | MCP 实例、启动参数、具体工具/资源的授权适配及其安全用途属于部署配置或 Scenario Package，不得开放绕过 Gateway 的目标/文件/秘密访问。

#### Codex 装配方式对 TraceForge 的具体参考

Codex 的装配不是“把所有知识一次性塞进 Prompt”，而是 Host 在启动和每个 Turn 中分层组合：项目规则和历史上下文先形成基础约束，Skill
先以元数据进入可发现列表，选中后才加载完整指令和附属资源；MCP 按配置建立连接并发现 Tools、Resources、Prompts，只有实际需要的资源或工具结果
才进入当前上下文。官方文档把这些层明确区分为项目指导、Memories、Skills 和 MCP；Skill 采用渐进式加载，MCP 同时承载动作和外部上下文。
参考：[Codex customization](https://developers.openai.com/codex/concepts/customization)、[Build skills](https://developers.openai.com/codex/skills)、
[MCP](https://developers.openai.com/codex/mcp)。

```text
Host 启动
├─ 读取 AGENTS.md / 配置 / 可用 Memory
├─ 扫描 Skill 目录，只建立 name + description + path 索引
└─ 读取 MCP 配置，连接 Server，发现并过滤 Tools / Resources / Prompts

Turn 开始
├─ 任务匹配 Skill → 加载 SKILL.md
├─ 按需读取 references / assets，按需执行 scripts
├─ 按需读取 MCP Resource 或调用 MCP Tool
└─ 将受限结果加入上下文；过长时执行压缩并继续
```

TraceForge 不直接复制这套宿主实现，而是把它改造成安全底座 Contract：

1. **Skill 装配**：先暴露技能摘要和版本，再在 Work 获得能力/授权后加载完整 Playbook；完整指令、脚本和参考资料都绑定 Package、digest 和
   Output Schema，不能凭文字指令绕过 Tool Gateway。
2. **知识装配**：不建立一个不可审计的“万能知识 Prompt”。将 Evidence Graph 的持久化事实、Scenario Resource 的受控资料、当前 Run/Work 状态和
   MCP Resource 读取结果分层注入；每条注入记录保留来源、版本、权限、fingerprint 和是否为事实/线索/证据的类型。
3. **MCP 装配**：保留 Codex 的“配置 → 连接 → 发现 → 工具过滤”思路，但生产链必须是 `MCP Adapter → Tool Discovery/Provider Runtime →
   PolicyExecutionToolGateway → Execution Node/Host Broker`。MCP Server 的 `instructions`、Tool annotations 和 Resource 内容都是不可信输入，必须
   经过能力映射、Scope、审批、超时、输出上限和 Receipt/Evidence 记录。
4. **上下文装配**：模型只接收当前 Work 所需的最小 Skill、Knowledge 和 Tool Schema；原始响应、代码、流量、日志和凭据不直接进入长期上下文，使用
   Artifact/Receipt 引用和有界摘要。压缩时保留 Evidence、Approval、Work、Revision 和恢复所需身份，摘要不能改变图谱或授权。
5. **失败与刷新**：Skill/MCP/Knowledge Resource 发现失败、版本不匹配、权限过期、连接中断或输出超限时，目录降级/失效但不静默换版本；需要恢复时
   进入 recovery-required，不让模型自行重试可能有副作用的调用。

#### 纳入底座开发的统一边界

后续应把三者合并为一个“可审计能力与知识装配”底座批次，而不是分别做三个孤立系统：

1. Skill 只描述“怎样组织一次安全工作”，Knowledge 只提供“目前已知且可追溯的事实/线索”，MCP/Provider 只提供“受控执行能力”；三者不能互相冒充验证结论或授权。
2. 所有 Skill、Knowledge Resource 和 MCP Tool 都必须携带 Package/Provider 版本、digest、Case/Run/Work 归属和来源引用；缺少绑定、权限或完整性证明时不进入模型可见目录。
3. MCP 的生产接线必须改为 `MCP Adapter → Tool Discovery/Provider Runtime → PolicyExecutionToolGateway → Execution Node/Host Broker`，调用结果进入 Receipt/Evidence 链；当前 `McpManager` 直连 stdio 的路径只能保留为开发/兼容接口，不能作为生产安全执行通道。
4. 底座验收先使用中性 Skill、Knowledge 和 MCP fixture；底座完成后，Web 黑盒、白盒审计和红队横向各自装配自己的技能与知识包，不修改 Core 或通用 Runtime。

通俗作用：技能决定“怎么查”，知识库记录“已经知道什么、证据从哪来”，MCP/工具负责“实际做什么”。底座要保证三者接起来时每一步都有版本、授权、证据和回滚边界；这样以后换 Web、代码审计或内网场景，只是换技能和知识，不需要重写底层执行系统。

### P0：Scenario Extraction 与通用运行时边界

当前状态：六段纵向改造已完成。Core 已能在不知道 Web 名称和 `validation` 语义的情况下注册、启动、
调度和恢复；Web Definition 已成为独立 workspace 包；Foundation、Routes 和 Embedded Worker 通过显式
Package Registry 装配，零 Package 时不注册场景 Definition 或场景工具；Execution Node Authorization 已通过
通用资源授权端口解耦；Scenario Contract 已提取为独立 SDK，Web 工具不再依赖 Server/SQLite；Run 已固定绑定
Package id/version/schema revision；版本化 Output Schema 和通用 Evidence Port 已接入生产完成路径。
Prompt/知识资源引用与 migration manifest 的通用 Contract、保留状态迁移命令已完成；具体场景资源装配、自动排空和任意状态转换仍未完成。

最新底座门禁补充：根目录新增 `verify:foundation`，先扫描全部 packages 与通用 Server 生产源码的依赖边界，
再只构建 14 个通用 packages，并用排除 `main.ts`、应用测试和场景测试的独立 TypeScript 配置编译通用 Server。
该路径不构建 `apps/web` 或 `scenarios/web-blackbox`。中性测试包覆盖开放身份、Prompt/知识资源引用、内容摘要和
migration manifest 引用完整性；产品入口仍可显式装配 Web 包，但不属于底座构建。

本轮实际完成：

- 将 Scenario、Work、Worker Role、Execution Role 和 Output Kind 改为开放身份；现有持久化字符串保持原值。
- 将默认角色、同类 Work 并发、最少 Hypothesis 引用和完成输出约束移入通用 Definition policy，删除 Core
  对 `research`、`validation`、`review`、`report` 的解释。
- 新建 `scenarios/web-blackbox`，迁移 Web Definition、能力、拓扑及其场景回归测试；Core 删除对应导出。
- Definition Registry 默认允许空注册并在注册时验证 Definition；Foundation/Routes/Embedded Workers 共用
  外部注入的 Registry，Worker Pool 按 Definition 声明的 Work Kind 匹配需求。
- Run 路由的场景、工作、角色和输出输入改为开放字符串；授权动作按已注册 Definition 校验，Run 可用能力
  来自持久化授权 Envelope 与在线 Worker，而不再由路由补写 Web 基础能力。
- 新增 Core 禁止具体场景身份/import 的边界测试、开放身份中性夹具和空 Definition Catalog 路由测试。
- 新增 `ScenarioPackageInstallation/Registry` 宿主契约，显式汇总 Definition、Authorization Policy 和 Tool Source；
  Web Scope Schema 已从通用 Route 移入 Web 包，Route 只接收不透明 scope payload 并调用当前包解析。
- 删除 Embedded Worker 内的 Web Guard/HTTP/Traffic/Session/Browser 默认工具数组；Web 产品入口显式安装
  `WEB_BLACKBOX_PACKAGE` 后才出现相应 Tool Source，并增加零包/启用包和 Server 通用模块防回退测试。
- 新增通用 `ScenarioAuthorizationPort` 与 SQLite Envelope Adapter；动作和资源授权委派给 Package Policy，
  Web URL/目标规则进入 Web Package Adapter。Execution Node HTTP Broker 与 Web 工具统一消费该端口，删除
  `ScenarioAuthorizationGuard`，并用中性 `fixture.subject` Scope/资源证明通用服务不解释 URL 语义。
- 新建 `@traceforge/scenario-sdk`，将 Package Registry、Authorization、Session、Traffic 和 Tool Host Contract
  从 Server 实现中抽离；Package Registry 同时拒绝重复 Package、重复 Definition 和重复 Tool Source 身份。
- 将 Web HTTP/Traffic/Session/Browser Tool Adapter 与 `WEB_BLACKBOX_PACKAGE` 安装清单物理迁入
  `scenarios/web-blackbox`；工具只依赖 SDK 端口，Server 新增 `SqliteScenarioTrafficStore` 并让现有
  `ExecutionSessionGateway` 实现通用 Session Port，Traffic/Session 数据与回执语义保持不变。
- 为 Package Installation 增加版本和 Schema revision；Run Start Event 与 `scenario_event_streams` 投影持久化
  精确绑定，Runtime 通过通用 Binding Validator 阻止缺包、错版本和 Schema 不匹配的 Run 继续执行。
- 旧数据库迁移只增加 nullable binding 列；历史 Run 不自动假定为 Web。Run 列表暴露 availability/diagnostic，
  单 Run API 返回 `recoveryRequired`，Web 控制台跳过不可执行 Run 并展示恢复原因。
- SDK 新增版本化 Output Schema 和 `ScenarioEvidencePort`；Package 安装拒绝遗漏 Definition 所需输出 Schema，
  Work Completion 按当前 Run 的精确 Package binding 校验并持久化 schema version。
- Web Package 自己声明 `scope_snapshot`、`hypothesis`、`validation_conclusion` 等输出 Schema，并将通过校验的
  Output 幂等映射为通用 Evidence Graph 节点；Server Adapter 不解释任何 Web 输出类型，也不把 Output 单独当作
  已验证 Finding 或伪造外部 Evidence Source。

阶段 A：冻结与依赖边界

- 建立依赖规则：`orchestration-core`、`worker-runtime`、`execution-node`、`evidence-graph` 和通用 Server
  不得导入任何 Scenario Package，也不得声明 `web_blackbox`、`code_audit`、`red_team_lateral` 等具体值。
- 暂停新增 Web 工具、黑盒 Planner 策略、Browser 能力和场景专属数据库分支；允许修复不扩大耦合的缺陷。
- 形成场景侵入清单，覆盖类型、Definition、Worker 拓扑、授权、工具、路由、Prompt、Schema、持久化投影和测试夹具。

进度：Core 与通用 Server 边界门禁均已落地并强制通过；产品入口和 Web 集成测试允许显式 import Web 包，
通用 Foundation、Routes、Embedded Worker、Authorization/Traffic Adapter 和 Execution Node Service 禁止回退。

阶段 B：定义真正通用的 Scenario Package Contract

- 将 `ScenarioKind`、Worker Role、Work Kind 和 Output Kind 改为经过命名空间与格式验证的开放标识符，
  Core 只比较身份、版本、能力集合和生命周期，不解释其领域语义。
- Planner 与 Observer 可以继续作为平台级认知职责存在，但其具体策略、Prompt、阶段解释和 Worker Role
  不能由 Core 固定；Scenario Worker Role 必须是开放标识符并通过能力/策略匹配。
- Core 只保留通用 `ScenarioDefinition`、Phase/Transition、Worker Pool、Capability Demand、Authorization
  Requirement 和 Output Envelope；具体输出 Schema 由 Scenario Package 注册并按版本验证。
- 定义 `ScenarioPackage`：包含 Definition、Worker 策略、Tool Discovery Sources、授权策略、输出 Schema、
  Prompt/知识资源和可选持久化迁移；安装与启用必须经过显式 Registry，不允许模块导入产生隐式注册副作用。
- Core 只持久化通用 Authorization Envelope（归属、策略类型、版本、状态、有效期和不透明 scope payload）；
  具体目标、动作和 Scope 判断由当前 Run 绑定的 Scenario Authorization Policy 解释。
- Run 创建时必须持久化准确的 Scenario Package id/version/schema revision。运行中的 Run 固定使用该版本，
  不因 Registry 刷新静默迁移；禁用包只阻止新 Run，已有 Run 必须明确排空、完成或由迁移命令处理。
- Server Composition Root 只依赖 Scenario Registry/Loader 接口。零 Scenario 时仍可启动、查询健康状态、
  管理 Provider，并明确返回“未安装场景”，而不是默认装配 Web Worker。

进度：开放身份、Definition Work policy、空 Registry、显式 Package 安装、Authorization Policy、Tool Source、
通用授权路由委派、独立 SDK 和版本固定的持久化 Package binding 已完成；Scenario Package 不再反向依赖 Server。
版本化 Output Schema 与 Evidence Port 已完成。开放标识符格式验证、Prompt/知识资源引用和 migration manifest
的通用 Contract 已由中性 fixture 验证；2026-09-01 补齐保留状态的显式迁移，自动排空及任意状态转换未完成。本阶段没有补写 Web 专属内容。

阶段 C：抽离 Web 黑盒包

- 新建独立 `scenarios/web-blackbox` workspace package，将 Web Definition、能力、Worker 拓扑、阶段、
  授权 Guard、HTTP/Traffic/Session/Browser 工具、输出 Schema、策略和测试移入该包。
- 删除 `orchestration-core` 对 Web Definition/常量的导出，删除 Embedded Worker 对 Web Profile 和 Web 工具的直接引用。
- Web 包通过通用 Contract 显式注册；只有配置安装并启用该包时，Registry 才出现 `web_blackbox@版本`，
  Tool Runtime 才出现 `web.*` 能力，相应 Worker Pool 才能创建。
- 保持现有 Run/Event/Evidence 数据可读；迁移只转换标识符和注册归属，不伪造生命周期事件或执行回执。
- Scenario Package 与 Tool Provider 是两个独立概念：前者定义调查语义、策略和装配，后者提供受控执行能力；
  Web 包可以声明所需 Provider capability，但不得绕过 Tool Runtime、Provider 签名或权限门禁直接启动工具。

进度：Definition、阶段、Worker 拓扑、声明式 Authorization/Output、Skill、Knowledge、Scenario Process 与结构化 HTTP
探索均已迁入签名数据包；Web 包生产代码不再 import Server 或 SQLite，应用入口也不再硬编码 Web 安装。旧同进程
Traffic/Session/Browser 工具不进入生产组合根；认证会话、脱敏流量历史和 Brokered Browser 将继续通过 Package 与宿主显式能力接入。

阶段 D：架构验收与防回退

- 增加 Core/Server import-boundary 测试，禁止通用层引用 `scenarios/*` 或具体场景常量。
- 增加零场景启动测试：Core、Server、Worker Runtime、Execution Node、Evidence Graph 全部构建并运行，
  Scenario Registry 为 0，默认工具目录不含任何 `web.*`、代码审计或红队能力。
- 增加 Web 包装配测试：启用后才注册 Definition、工具、授权策略和 Worker Pools；禁用或移除后通用底座仍通过测试。
- CI 增加“排除整个 Web Scenario Package 的底座构建”任务，防止通过间接 import 再次把场景拉回 Core。
- 增加开放扩展示例或中性测试包，只使用 `first scenario`、`first role`、`first output` 等名称证明新增场景无需修改 Core。

进度：`verify:foundation` 已成为可重复执行的独立门禁，检查 211 个通用生产源码文件，并在不构建 Web 应用、
Web Scenario Package 和产品 `main.ts` 的情况下完成底座 package 构建、通用 Server 类型检查及 97 项 Runtime、
Scenario Contract、Core、Broker 与 Recovery 边界测试。后续继续随 Runtime 提取把通用行为测试纳入该门禁。

迁移提交顺序：

1. **边界清单与 CI 门禁**：只增加依赖检查和现状失败清单，不改变运行行为。
2. **开放标识符与兼容读取**：先让 Core 接受注册的字符串身份，同时继续读取现有持久化值；不移动 Web 实现。
3. **Package Contract 与零场景宿主**：建立显式 Registry/Loader、版本绑定和空 Registry 启动路径。
4. **Web 包迁移**：按 Definition/Policy → Worker 策略 → Authorization → Tools/Schema 的顺序迁移，每一步保持测试可运行。
5. **删除兼容入口**：移除 Core/Server 的 Web export、默认注册和旧 import，启用“排除 Web 包构建”作为强制 CI。

后续每一步继续形成独立可回滚提交；本轮没有修改数据库格式、事件历史或 Evidence 引用。任何阶段失败时，
应能回退该阶段而不破坏之前的 Run/Event/Evidence 数据。

持久化兼容策略：

- 现有 `web_blackbox`、角色、阶段和输出字符串按原值保留，不通过批量重写伪造新事件历史。
- Event/Projection Reader 通过显式 schema version 和兼容 decoder 读取旧记录；新写入使用开放标识符与 package binding。
- 找不到 Run 所绑定的 Scenario Package/version 时，Run 进入可诊断的 blocked/recovery-required 状态，
  不默认套用当前 Web 包、不自动升级，也不丢弃已有 Work、Approval、Evidence 或 Receipt。
- Scenario 自有持久化数据使用命名空间和显式 migration manifest；通用 Core 表不增加某个场景专属列或 enum constraint。

验收条件：

- `orchestration-core` 和通用 Server Composition Root 中不存在具体场景 Definition、能力、角色、阶段、输出类型和工具装配。
- Core 的场景、角色、Work 和输出身份不再是枚举具体应用的闭合 union；未知但合法、已注册的标识符可工作。
- 删除或排除 `scenarios/web-blackbox` 后，全底座能够 build、启动和通过非场景测试，Registry 显示 0 installed scenarios。
- 显式启用 Web 包后才出现 Web Profile、Worker Pools、授权动作和 `web.*` 工具，且停用后不再对新 Work 可见。
- 新增第二个中性 Scenario Package 不修改 Core、通用 Server、Worker Runtime、Execution Node 或 Evidence Graph。
- 旧 Web Run 的 replay digest、关键 Projection 和 Evidence 引用在迁移前后保持一致；需要变化时必须由版本化迁移测试解释。

底座完成门禁：

- 排除 `apps/web` 和整个 `scenarios/web-blackbox` 后，通用 packages 与 Server 底座能够构建并通过测试，
  零场景启动时 Registry 为 0，且不存在间接 import 或默认场景装配。
- 至少一个不依赖 Fastify、SQLite 具体实现和任何 Scenario Package 的 Runtime integration harness 可组合
  Run、Work、认知循环、Evidence、Tool Gateway 与恢复路径。
- Runtime packages 不反向依赖 `apps/*`、桌面实现或具体场景；Server 只保留 Transport、Adapter、Persistence
  Wiring 与 Composition Root 职责。
- Provider-to-Host Broker、Provider 隔离/恢复、持久化调用回执和版本治理均通过中性 capability fixture 验证，
  Host 不解释 URL、浏览器、仓库或横向移动等场景语义。
- 受支持平台的执行约束具有可验证证明；不满足约束的平台明确关闭相关能力，不存在普通进程执行回退。
- 重启恢复、故障注入、资源耗尽、长稳运行、容量边界和安全基线达到文档化验收标准；通用控制操作先由
  API 和审计回执闭环，不以应用界面代替底座能力。

以上条件全部通过并同步本路线图后，才允许进入应用与场景适配阶段。单个场景“看起来能跑”不能替代底座验收。

在这一验收完成前，不接受“只是把 `web-blackbox.ts` 换个目录”、继续保留闭合场景 union、由 Server
直接 import Web 工具，或启动时默认隐式注册 Web Profile 的表面修复。

### P0（主链已完成，Scenario Extraction 期间暂缓后半段）：持久化 Tool Provider Manifest 与供应链控制面

当前状态：包级安装、归档导入和生产启动纵切片已完成。签名清单、文件/包哈希、信任根、只读原子发布、
生命周期事件/投影、控制 API、隐式降级拒绝、显式回滚、启动恢复和按调用归属的 Execution Node
启动、调用感知排空切换、中断生命周期对账、确定性签名归档、受授权导入和显式刷新审计已具备；
以下仍需完成整链故障注入与发布验收。

开发内容：

- 已完成 Manifest Schema、Event Store/查询投影、本地信任根、签名与哈希验证、生命周期 API、
  隐式降级拒绝、显式回滚、enabled 版本启动恢复、包级原子发布、生产来源工厂、generation 在途调用追踪、
  原子 `enabled`/`draining` 切换、排空后关闭和重启对账、归档上传/安全解包、签名发布工具、
  显式刷新 API、持久化调用归属与回执恢复、旧包回收。
- 待完成分发、安装、升级、刷新、排空、恢复和回收路径的系统级故障注入与长稳验收。

验收条件：Provider 包不能绕过签名和权限策略；升级期间新 Work 使用新版本，旧调用完成后旧进程退出；重启后目录与健康状态可恢复。

### P0：Provider-to-Host Capability Broker

当前状态：Scenario Extraction 验收后的第一项新能力。Broker 本身保持场景无关，只消费当前 Run 所绑定
Scenario Package 提供的 Authorization Policy 和平台权限交集，不能重新在 Host 中硬编码 Web action。

第一片 Broker Core 已完成：`ProviderCapabilityBroker` 接收宿主提供的可信 Tool 上下文，不接受 Provider
自报 Case/Run/Work/Worker/Lease 归属；能力语义由开放 Handler Registry 提供。Core 已统一授权端口、持久化
Receipt 端口、幂等 replay、跨进程 generation replay、深度、全局/Provider 并发、请求/响应字节、租约和
超时/Abort 限制。

第二片双向 RPC 已完成：本地 stdio 与 Execution Node Provider Client 均接受唯一反向方法
`host.capability.call`，从仍在途的 parent `tools.call` 恢复可信 Tool 上下文并调用 Broker。协议严格拒绝
Provider 自报的归属字段、未知/已结束 parent、未安装 Broker、重复反向请求和反向并发超限；进程退出或
generation 切换后不会把旧响应写入新进程。

第三片持久化与授权组合已完成：`SqliteProviderCapabilityReceiptStore` 持久化每次 pending/terminal 尝试并按
Provider/幂等键恢复最新 Receipt，重启后终态不重新执行；读取时执行严格 Schema 校验，损坏记录不会被当作
可信回放。`PolicyProviderCapabilityAuthorizer` 组合开放 Capability/Action Policy、有效权限、Scenario Scope 和
高风险审批；SQLite Approval Reader 只读取正式 Work 审批投影，不绕过事件生命周期直接写表。待审批 Receipt
允许在同一幂等键下重新授权，审批后继续执行。

第四片 Host Composition 已完成：`ProviderCapabilityHostRegistry` 强制 Handler 与 Policy 一一对应，再组合
Broker、Receipt、Scope 和 Approval 端口；Foundation 只在显式提供非空注册项时创建 Host，并将其注入默认
Managed Provider Source。双方为空时保持关闭且不会宣告 `host.capability.call`，只有一侧存在则启动失败；
诊断明确显示 Host 是否启用。当前仍未注册任何具体 Capability Handler，也未把应用层或具体场景能力写入底座。

第五片中性生产组合验收已完成：真实 Provider 子进程通过 Managed Provider Source 和带 attestation 的测试
Execution Node 发起反向调用，Host Registry 完成 Policy/Scope 授权并持久化 SQLite Receipt；数据库重启后的
相同调用直接 replay，既不重新授权也不再次执行 Handler。Execution Node 传输测试同时证明 Provider generation
关闭后才完成的 Host 结果不会写回旧进程。测试专用 attestation launcher 只存在于 fixture，不构成生产弱沙箱回退。

开发内容：

- 扩展双向 RPC，使 Provider 只能通过 Host Broker 请求 HTTP、文件、会话、浏览器、秘密句柄和 Artifact 能力。
- 每个反向请求绑定 Case、Run、Work、Worker、lease、scope、action 和 idempotency key。
- Host 再次执行 Scope Guard、权限交集、风险分级和审批检查。
- Provider OS 网络默认 deny；Brokered 能力返回持久化 Receipt 和 Evidence 引用。
- 限制反向调用深度、并发、字节、超时和递归，防止 Provider 形成代理逃逸或调用风暴。

底座验收条件：一个网络 deny 的 Provider 可以通过唯一反向方法完成经过授权的中性 capability 调用，不能自报
归属，且所有调用均有可追溯回执；该条件已通过。Brokered HTTP 和未授权目标阻断属于后续 Scenario Adapter
验收，不得为满足示例而把 URL 规则写回 Host Core。

补充验收：用中性 Scenario/Capability fixture 证明 Broker 不认识 URL、浏览器、代码仓库或横向移动语义；
Web HTTP 只是 Web 包注册的一种 Broker capability adapter，而不是 Host Broker 的默认业务规则。

### P0：Tool Runtime 恢复、隔离和故障治理

当前状态：第一片通用恢复状态机已完成。`ToolProviderRecoverySupervisor` 只识别 crash、transport、protocol、
policy、resource 和 unknown 六类基础设施故障，统一指数退避、可注入抖动、滑动失败预算、并发恢复合并、
稳定观察窗口和粘性 quarantine。状态通过 `ToolProviderRecoveryStatePort` 持久化；宿主在 recovering 阶段崩溃时，
重启会恢复为 backoff，损坏或生命周期矛盾的快照会显式拒绝。protocol/policy 故障立即隔离，quarantine 不会因
后续错误或时间流逝自动解除。

第二片持久化与默认生产接线已完成：`SqliteToolProviderRecoveryStateStore` 按 Provider/version 保存严格解析的
完整快照，拒绝损坏 JSON、Envelope revision 不一致和旧 revision 覆盖新状态。默认 Managed Provider Source
在 backoff/quarantine 时不会启动新进程；到期恢复由 Supervisor 合并为唯一尝试，普通工具业务失败不计入
Provider 故障预算。预算耗尽后异步投影到既有 Tool Provider Control Plane，来源在当前调用释放所有权后排空并
转为 `quarantined`，避免在途调用等待自身关闭。自定义 Source Factory 仍需显式实现或选择自己的恢复接线。

第三片 Discovery 重启安全状态已完成：`ExecutionToolDiscoveryStatePort` 持久化每个来源的单调 revision、
最后成功目录、目录指纹、最新健康结果和最长 1024 字符的故障原因；SQLite Adapter 严格拒绝损坏 JSON、
Envelope revision 不一致、目录指纹不一致和旧 revision 覆盖。重启恢复出的目录只作为历史与诊断数据，来源仍为
`pending`，不会注册任何可执行实现；必须由当前进程重新发现并成功持久化后才进入 `ready`。首次重发现失败会
保留上次成功目录作为审计线索但继续不可执行；新目录若无法提交持久化状态，会回滚注册表到上一个当前进程已验证目录。
启动组合先恢复静态来源历史，再恢复 Managed Provider；动态出现的 Managed Source 会接续已有 revision，避免回写旧状态。

第四片双向 quarantine 重启对账已完成：`ToolProviderRecoveryReconciler` 在任何 Provider 激活前完整读取并严格
校验全部已安装版本的恢复快照，再按“隔离取并集”对账。恢复快照已隔离但控制面投影前崩溃时，会使用确定性
command id 补写控制面事件；控制面已隔离而恢复快照缺失、健康或停在 recovering 时，会写入更高 revision 的
粘性隔离快照。任一损坏记录都会在任何投影发生前阻止整批启动；无关健康来源不写状态、不调用隔离，也不受影响。

第五片真实启动组合验收已完成：启动顺序提取为 `recoverToolRuntimeStartup`，固定执行“恢复 Discovery 历史 →
对账 quarantine → 恢复控制面 enabled 来源 → 刷新目录”。中性 SQLite harness 使用真实签名控制面、
`ExecutionToolDiscoveryRuntime`、生产 `createManagedToolProviderSourceFactory` 和两次完整重启，证明投影前崩溃的
隔离版本从未创建 Managed Source、历史成功目录没有复活，健康来源仍独立进入 active；第二次启动不重复写
quarantine 事件。该验收同时发现并修复热激活路径曾将运行时 `execute` 函数计入目录指纹的问题，所有路径现在
统一只对可持久化 `ExecutionToolSpec` 计算指纹。

第六片 Provider 诊断隔离已完成：`ToolProviderDiagnosticWriter` 与有界 Record Contract 将本地 RPC 和
Execution Node 两条生产路径的 stderr、进程退出、协议/传输错误及 Provider 自报错误从公开异常中分离。
公开异常、Recovery failure 和 Runtime diagnostics 只包含最长 512 字符的通用摘要与不透明 diagnostic id；
Provider 自报 code/message 和 stderr 只进入最大 16 KiB 的独立 detail，记录原始/省略字节、Provider generation
及 Case/Run/Work 归属。SQLite Adapter 持久化诊断但没有把 detail 暴露给模型或公共 Runtime 状态；写入失败时
降级为不含原始细节的通用摘要。测试覆盖多字节安全截断、超长 Provider 自报错误、stderr 崩溃和持久化读取。

第七片 Provider 公平调度已完成：`ToolProviderFairScheduler` 在 Managed Provider 进程启动前统一取得执行所有权，
同时约束全局、Provider/version、工具、Run 和 Work 五层并发；队列按 Run 轮转，并跳过暂时达到自身配额的队列，
因此一个 Run 被限制时，其他 Run 仍能使用剩余容量。等待队列有硬上限和最长等待时间，queue full、wait timeout
与 cancellation 都返回可重试的通用调度错误，并将开放身份、结构化原因和等待时间写入独立 SQLite 审计表。
Gateway 超时通过仅限 Host 本地、RPC 不序列化的 AbortSignal 取消排队或关闭在途的每调用 Provider 进程；本地调度名额在
该调用清理路径结束后释放。后续已加入有界终态观察，但清理错误时该内存名额仍可能释放，不能据此推断实际进程已消失；
未知调用仍由持久化 Invocation/Execution Node 围栏阻断。清理未知时统一保留/重建所有调度配额仍需后续治理。调度拒绝和取消被标记为 Recovery 中性，
不会消耗 Provider 故障预算或诱发 quarantine；Runtime 公开诊断只显示总 active/queued 与 limits，不暴露 Run/Work 身份。
测试覆盖跨 Run 可用容量、公平跳过、多层配额、队列上限、等待超时、取消、幂等释放、SQLite 审计及真实进程取消。

第八片 Provider 升级 Contract/Schema 审计已完成：`assessToolProviderCompatibility` 对签名 Manifest 投影出的
Provider 身份、source、协议、能力、平台、宿主权限、资源、执行包指纹和每个工具的输入 Schema、能力依赖、
权限需求、风险与超时做确定性比较，结果分为 `compatible`、`requires_drain` 和 `breaking`。输入 Schema 只在能够
证明旧输入仍被接受时判为兼容，例如增加非必填字段；增加必填字段、删除工具、移除能力、增加依赖、提高风险或
宿主权限，以及任何无法证明兼容的复杂 Schema 变化都保守判为 breaking。普通 enable 在创建新 generation 前完成
比较，breaking 会在 Runtime activation 前阻断；资源、执行包或收紧策略等 requires_drain 变化继续使用既有
generation draining。显式 rollback 同样记录比较结果，但保留其作为人工恢复动作的语义。

每次比较将操作者、命令、from/to 版本、Contract 指纹、分类和不含原始 Schema 的结构化变化摘要写入独立 SQLite
审计表，并提供通用只读 API；重复命令必须得到同一报告，损坏 JSON、Envelope 或指纹会显式拒绝。当前仍缺少
“某次尚未完成的 Tool Invocation 精确绑定了哪个 source/version/contract fingerprint”的持久化事实，因此本片只
保证升级入口不会静默接受破坏性 Contract，不宣称历史或中断中的调用已经可以自动恢复到原 Provider 版本。

第九片 Tool Invocation Contract Binding 已完成：Gateway 在审批或执行前通过
`ToolInvocationBindingStore` 持久化幂等键、Invocation id、工具 name/source/version、纯 `ExecutionToolSpec`
Contract fingerprint、输入 fingerprint 及 Case/Run/Work 归属。运行时 `execute` 函数、description 和 priority
不会进入 Contract 指纹；RPC 或进程对象也不会被序列化。相同幂等键重试必须与所有绑定字段完全一致，换输入、
换工具版本或改变 Contract 都会在执行前冲突。审批等待保留 `prepared`，拒绝或工具终态回执持久化后转为
`completed`；已有 Receipt replay 会补齐可能因崩溃遗漏的 complete，另保留带原因的 `released` 生命周期供取消对账。

生产 `SqliteToolInvocationBindingStore` 严格验证 SHA-256、身份和状态，按 source/version 查询未完成绑定；Provider
普通升级、drain、disable 和 rollback 在 Runtime 变更前遇到未完成绑定会拒绝，quarantine 仍保留安全隔离优先级。
绑定表不删除历史记录，当前 Package Store 也没有清理旧版本，因此不会因本片引入旧包丢失。测试覆盖审批后版本
漂移拒绝、输入不可变、重启持久化、complete/release 和控制面保护。

第十片原子 Admission Fence 与终态对账已完成：每个 source/version 的准入状态、原因和单调 revision 进入独立
SQLite 表。Binding `prepare` 在同一数据库事务中先识别完全一致的既有 prepared 重试，再检查围栏并创建新绑定；
因此旧调用在关闸后仍能按原所有权恢复，而任何新幂等键都不能越过围栏。控制面升级、drain、disable 和 rollback
先持久化关闭旧版本准入，再检查未完成绑定和切换 Runtime；未排空、Contract breaking 或 activation 失败会重新开放
仍需服务的旧版本。成功切换、disable、drain 和 quarantine 保持旧版本关闭；启动恢复在激活 enabled 版本前重新开放，
并关闭重复 enabled、失败激活和中断 drain 的入口，从持久化事实收敛半开状态。

`SqliteScenarioEventStore` 在写入通用 `work_completed`、`work_failed`、`work_blocked`、`work_cancelled`、
`run_completed` 或 `run_cancelled` 的同一事务中，将对应 prepared Binding 转为带原因的 released；审批拒绝和正常工具终态
仍由 Gateway 在 Receipt 落盘后完成。这样控制面不会被已经永久结束的 Work 虚假占用，也不会把可重试的 requeue、lease
过期或 pause 错当成终止。实现只识别开放的 Run/Work 生命周期，不包含任何场景、漏洞、协议或工具特例。

第十一片 Provider 诊断 detail 生命周期治理已完成：`SqliteToolProviderDiagnosticStore` 的默认查询只返回不含
原始 detail 的有界摘要；detail 读取必须提交非空 actor 和用途，通过显式 `ToolProviderDiagnosticDetailAuthorizer`。
允许、拒绝、不存在和已清理四类结果全部进入独立访问审计；授权器异常或返回非法结果会 fail closed，并写入通用拒绝
原因而不泄露授权后端异常。授权等待期间若 detail 被并发清理，事务内复查会阻止迟到读取。

保留策略可配置时间、最大保留记录数、最大 detail 字节数和单批清理量。启动、写入、摘要/原文读取及默认生产组合的
30 秒维护周期都会推进清理；写入在同一事务内强制容量硬上限，超限时按最旧记录分批收敛。清理只擦除 detail 并记录
purged 时间与原因，不删除摘要、归属元数据或 opaque diagnostic id，因此公开错误引用仍可追踪。每次有实际清理、容量
未收敛或显式 scheduled 维护都会写入持久化清理审计；重复执行只处理仍 retained 的记录，具备幂等可重入性。

第十二片 Provider 所有权感知垃圾回收已完成：`ToolProviderGarbageCollector` 对持久化安装版本、托管包目录和
每调用 scratch 目录生成可审计候选快照，dry-run 与实际执行使用同一判定并写入独立 Run/Candidate 表。包只有处于
`disabled` 或 `failed`、超过宽限期、没有 prepared Binding、没有 active/draining Runtime Contract、也没有
backoff/recovering/observing/quarantined 恢复所有权时才能进入删除批次；`installed`、`enabled`、`draining`、
`quarantined` 和所有权不明对象全部保留。崩溃遗留且未被任何 Manifest 引用的 staging/孤儿包也必须经过同一宽限期。

scratch 身份由 Run、Work 和幂等键的确定性哈希恢复，prepared Binding 对应目录不会删除；非法层级、符号链接、特殊
文件或不可读对象 fail closed 为 skipped。所有实际删除都重新限制在 realpath 托管根下，按每轮硬上限分批执行并记录
释放字节、跳过原因与失败数。被清理的安装版本进入新的 `collected` 终态，保留 Manifest、签名和审计历史；重新提交
完全相同的签名包会原子恢复为 `installed`，但不能在 payload 缺失时直接 enable/rollback。默认生产组合在完整启动恢复
之后执行一次，此后每小时维护，避免与恢复接管竞态或每 30 秒制造无意义审计膨胀。

第十三片 Provider 确定性签名归档底座已完成：新增版本化 `.tfpa` 格式，以规范 JSON、稳定路径排序、逐文件摘要、
可执行位和 Ed25519 Manifest 签名生成字节可复现的 gzip 归档；`provider:publish` 离线命令只从显式私钥文件读取签名材料，
POSIX 下拒绝组/其他用户可读的私钥和符号链接私钥，输出只包含包身份、摘要、大小和签名者标识，不回显私钥内容。

导入端在任何包文件落盘前先限制压缩体积与解压后 Envelope 体积，验证格式版本、严格字段、信任根和签名，再拒绝绝对路径、
路径穿越、反斜杠、控制字符、超长路径、乱序/重复/大小写碰撞条目、缺失目录和不支持类型。文件数、总条目数、包字节数、
单文件大小声明、规范 Base64 与逐文件 SHA-256 均受校验；随后只在独立 staging 目录重建只读文件，复算整个包与入口文件摘要。
任一阶段失败都会清理本次 staging，不发布半成品。发布端还会前后两次检查源包库存，避免打包过程中内容变化产生不可用归档。
第十三片完成时只交付归档库和 CLI，控制面仍只接受本地 `packageRoot`；这一阶段边界已由下面第十四片补齐，不能倒推成
第十三片当时已经具备远程分发能力。

第十四片 Provider 归档控制面接入已完成：新增 `application/vnd.traceforge.tool-provider-archive` 原始归档导入 API，上传体不在
内存中整包聚合，而是边接收边计算 SHA-256、边写入 0600 临时文件，并在压缩字节硬上限和并发槽位处拒绝资源滥用。导入必须
经过可注入 `ToolProviderArchiveImportAuthorizer`；未配置授权器时默认拒绝，不会把 HTTP 来源或请求里的 actor 字符串误当成授权。
授权通过后才复用第十三片验签/解包和既有 `ToolProviderControlPlane.install` 原子发布，上传、staging 与正式 Package Store 的
所有权保持分离。

每次请求以 command id、actor、归档摘要和大小生成稳定指纹；完全一致的成功重试返回既有安装结果，不同输入复用 command id
会冲突拒绝，进行中的并发重试也不会启动第二次安装。授权结论、签名者、Provider 身份、成功/拒绝原因及上传/解包清理结果进入
独立持久化审计。启动时会用内部安装 command 对账中断请求：已提交安装收敛为 installed，未提交收敛为 rejected；数据库尚未
来得及登记的孤儿 upload/staging 也会按严格托管路径清理，并写入 cleanup run 审计。旧的 `packageRoot` HTTP 安装路由现在默认
关闭，只能由显式 `allowLocalPackageInstall` 测试/受控组合重新开放，避免绕过归档授权、验签和导入审计。底座只定义授权端口，
没有硬编码用户、令牌或部署身份；具体宿主若不注入可信授权器，归档导入保持 fail closed。

第十五片 Provider 显式刷新控制已完成：新增精确定位 Provider/version 的刷新 API、独立授权端口和持久化命令审计；
生产默认未配置授权器时拒绝。每个命令持久化授权结论、请求原因、刷新前后 discovery revision、签名目录指纹和结果，
相同命令重放不会再次调用 Provider，不同输入复用命令号会冲突；同一 Provider 的不同刷新命令严格串行，启动时把遗留的
`running` 审计收敛为失败而不擅自重跑。

刷新只重新发现并核验当前签名版本，不能原地改变工具目录。Managed Provider 返回的工具身份、能力、权限或完整目录与签名
Manifest 不一致时均拒绝提交；探测失败或目录漂移时保留最后一次成功目录和正在执行的调用，并留下有界失败审计。
目录确需增加、删除或变更工具时，必须发布新的签名 Provider 版本并走兼容性检查和升级流程，刷新不能成为供应链旁路。

第十六片 Provider 整链故障注入第一组已完成：升级和回滚现在先关闭目标版本准入，再激活目标 generation，只有 SQLite
生命周期事务完整提交后才重新开放新调用。若持久化提交失败，控制面会保持目标版本围栏，停掉未提交的目标 generation，
重新激活原版本并恢复原版本准入；若补偿步骤自身失败，则返回包含补偿缺口的错误，不把运行态恢复伪报为成功。actor、reason
和 command id 等命令元数据也前移到任何运行态副作用之前验证，避免无效命令先改变进程或准入状态。

中性故障注入通过 SQLite trigger 在安装、升级和回滚的精确提交点制造失败，证明事务失败后不会留下半启用版本，原版本仍是
唯一持久化 enabled 版本，失败命令未被错误记账且可重试。包已原子发布、Manifest 事务却失败的窗口也已覆盖：无数据库归属的
最终包目录经过宽限期后由既有所有权感知 GC 识别并审计回收，不会冒充已安装版本。

第十七片 Provider 归档文件系统故障注入已完成：Buffer 与 HTTP 流式接收统一使用可处理短写的写入循环，零进度写入明确失败，
不再无限循环。完整归档接收前的失败进入独立 receive-failure 审计，记录每次尝试的 command id、调用者自报 actor、已收到的
字节数、有界原因和清理状态；不会为半个归档伪造完整摘要或授权结论，也不会占用已完成导入命令的幂等结果。清理失败的上传
在启动恢复中按持久化路径重试。该审计是内部查询能力，未新增未授权的 HTTP 读取入口。

解包器在创建 staging 后、写入任何条目前通知宿主登记目录归属，导入控制面先持久化待清理路径，再继续解包。解包和清理同时
失败时保留两类错误，审计不再误报“不需要清理”；安装已提交但清理失败时保留真实 installed 结果，恢复只清理临时文件而不
再次安装。上传清理还会检查托管根的 canonical 身份，拒绝越界记录和被符号链接替换的根目录。

新增 13 项应用级故障注入覆盖 ENOSPC、EACCES、零进度与短写、接收中断、staging 分配/子目录/文件写入、正式包 rename、
上传与解包清理重试以及外部路径保护。这些测试通过文件系统调用替身制造故障，未实际耗尽磁盘，也不等同于断电耐久性验证。
本片未覆盖数据库与文件系统同时不可写、跨进程强杀/重启、提交后准入重新开放失败以及补偿自身失败；后两片补充的范围见下文。

第十八片 Provider 归档安装跨进程崩溃恢复验收已完成：独立中性测试宿主使用真实磁盘 SQLite（WAL）与托管包目录，父进程
在确认关键点到达后向该子进程发送 SIGKILL，确保不会执行 catch/finally 收尾。七个断点分别是完整上传后、staging 创建后但
归属尚未登记、staging 归属已登记但尚未写文件、正式包发布后、Manifest 插入仍处于未提交事务中、安装事务已提交但导入审计
尚未完成，以及导入审计已经完成。断点仅存在于测试夹具，不向生产 API 增加故障开关。

每个断点之后由两个连续的全新宿主执行生产导入恢复、Provider 恢复和所有权感知 GC：SQLite 完整性检查通过，未提交事务
不会留下 Manifest 或安装事件，未安装版本无法启用；已提交版本保持 installed 而不自动启用，完整包不会被回收。正式目录中
的无主包在宽限期内保留，测试时钟越过宽限期后才回收。两次恢复均不授权或调用 Provider，第二次没有待对账记录或待删包。
随后再由新进程重复原请求，已提交安装只返回原结果，已拒绝命令不会重新执行，尚未登记的完整上传则允许显式重新发起安装。

这七项是实际进程终止/重启测试，不是伪造数据库终态；不过宿主操作系统和磁盘保持运行，所以仍不证明物理断电、fsync 耐久性、
整个执行节点故障或运行中 Provider 升级/回滚的跨进程恢复。这些边界继续保留，不将归档导入验收扩大成底座全部完成。

第十九片 Provider 激活提交后准入恢复与失败补偿已完成：enable/upgrade/rollback 在生命周期事务中同步记录 activation delivery
为 pending；只有目标准入开放与原运行态排空完成后才标记 completed。提交后的准入开放或完成记账失败会保留 pending、关闭
目标准入并记录有界错误；同一宿主重试复用已发起的排空任务，只补全交付，不重复激活 Provider 或追加排空事件。排空失败后
的重试不会短暂重新开放准入；同版本重新激活也必须等待运行态清理完成。

激活命令重放读取当前生命周期，且只有仍拥有当前激活事件的 pending 命令可以补开准入。后续停用、隔离、升级或同版本新命令
重新启用会使旧 pending 命令失去资格，重试只返回当前状态并标记 superseded。新控制面实例不具备旧运行态所有权，不能直接
补开准入，必须先完成启动恢复：围栏关闭、校验包并激活、等待排空、开放准入，再对账 delivery；恢复失败关闭准入、尝试运行态
排空并持久化 failed，不把历史 enabled 命令当成恢复许可。

生命周期事务失败后的补偿会等待原版本恢复和排空；目标停用、原版本启动、原版本排空或恢复准入任一步失败时，所有涉及版本
重新关闭准入、尝试运行态排空，并记录 failed 与补偿原因，避免账本仍宣称旧版本可用。新增 15 项测试使用真实 SQLite 准入
围栏配合运行态/事务故障注入，覆盖三个切换入口、失效命令重放、全新控制面恢复、交付记账失败及补偿自身失败。

本片尚不是切换期间的真实跨进程强杀验收；若数据库连失败审计也无法写入或运行态拒绝排空，不能宣称已经持久化全部失败结果，
只能传播组合错误并保留可建立的围栏。本片的跨进程切换恢复缺口由下一片补充；持续磁盘故障、真实断电和长稳验收仍未完成。
delivery 状态是内部恢复账本，未扩展应用层或增加无授权查询入口。

第二十片 Provider 激活切换跨进程崩溃验收已完成：新测试宿主接入真实磁盘 SQLite（WAL）、签名托管包、生产 Discovery Runtime、
Managed Source Factory、Invocation Binding/Admission Fence 和 `recoverToolRuntimeStartup`，不是在测试里拼造生命周期终态。
首次启用、升级和回滚各覆盖六个 SIGKILL 断点：目标围栏关闭、运行态目录已切换、生命周期事务内 delivery 插入但尚未提交、
生命周期与 pending delivery 已提交、准入开放但 delivery 尚未完成，以及 delivery 已完成。父进程确认断点后仅强杀该宿主；
事务内断点通过临时 SQLite trigger 确认，不向生产代码或 API 加故障开关。

每个断点之后使用两个全新宿主运行生产恢复链，检查 SQLite 完整性、Manifest/事件/delivery 原子性、当前可执行目录、准入
围栏及真实 Binding.prepare 的允许/拒绝结果；第三个新宿主重放原命令。未提交目标不会因 Discovery 历史目录而自动启用，
已提交目标补全交付并收敛旧版本 draining；连续恢复不重复生成生命周期事件。另覆盖旧激活已经完成或仍 pending 时被停用、
隔离、后续升级替代，随后强杀/重启与再次重放均不得重新开放旧版本。

验收同时发现并修复 Discovery 停用后缓存失效缺口：停用删除当前来源状态时，现在同步清除最初读取的恢复缓存；后续重新
激活从持久化层读取最新 revision，避免升级/回滚提交失败后恢复原版本时错误地重用过期序号，被存储层拒绝。新增两项有/无
启动历史的单元回归，并新增升级/回滚成功补偿后立即强杀的真实宿主测试。总计新增 26 项跨进程测试与 2 项序号回归，纳入
独立底座门禁。

边界仍明确：当前 Managed Provider 采用 per-invocation 执行所有权，启用只注册签名工具目录，不启动工具进程；本夹具明确
拒绝启动 Execution Node 进程。上述测试不证明有调用在途时的子进程清理、Work Lease/回执恢复、外部副作用去重、物理断电
或沙箱隔离；这些属于后续独立验收，未开发任何应用层或具体场景适配。

第二十一批调用中断恢复与重复执行防护已整体接入。新增 `tool_invocation_executions` 账本区分 prepared、executing、uncertain、
completed，记录宿主所有者、租约与有界原因；Binding 和初始账本原子建立。执行前再次检查准入、运行中的 Run、匹配且有效的
Work/Worker 租约和同 Work 未确认执行，再原子取得执行权。相同请求并发、换调用 id、过期租约均不能绕过执行所有权。

生产 Gateway 在模型获得工具目录前检查 Work 的未知执行，Worker 将其置为 blocked；执行声明之后的超时、Adapter 抛异常或
回执写入无法确认都保持 uncertain，不生成“肯定没执行”的失败回执。第二次存储故障导致 uncertain 审计失败时，原 executing
仍保护资源并传播错误。Adapter 明确返回的合法终态结果照常落回执；不配置 Binding Port 的独立 Gateway 保留兼容行为。

回执结构与重放身份（Case/Run/Work、调用 id、工具名、输入指纹）被校验。启动时在 Worker 接单前原子完成合法回执的收尾，
将旧宿主 executing 转为 uncertain；明确 prepared 可在新有效租约下执行，旧数据库无执行账本的 prepared/released 绑定保守
标记 uncertain。损坏回执不导致假完成。Work/Run 终态释放调度绑定时，执行账本仍保护未知调用的工具版本和暂存目录，Provider
切换门禁与 GC 都读取这层保护，直到已有合法回执完成对账。

新增 21 项 SQLite/Gateway 组合测试、6 项真实调用强杀测试、2 项 Worker blocked 回归和 1 项 uncertain GC 回归。真实测试
接入中性 Definition、事件持久化与租约恢复、Gateway、Execution Node、Provider RPC 子进程，在准备后、执行声明后未启动、
执行中、返回结果未写回执、回执已写未收尾、绑定已完成六个窗口强杀宿主；两个新宿主恢复/重放检查实际副作用计数，未知调用
不重新启动子进程，合法回执不重复执行。仅 prepared 且未启动的调用在重新取得租约后执行一次。

边界：启动对账仅用于单宿主独占数据库，不是多宿主选主或远程进程收养协议。测试 Provider 在 stdin 所有权通道关闭后退出，
并验证退出标记；测试 launcher 的 attestation 不证明任意工具/进程树会退出，也不证明原生沙箱隔离。生产恢复不会凭旧 PID
杀进程或收养未证明归属的进程。无合法回执的 uncertain 调用保持 blocked 与资源保护；没有可信证据和授权时不能自动解锁。

第二十二批未知调用授权对账闭环已接入通用 Server。新增 `ToolInvocationReconciliationControl`、写入/查询 API 和部署注入端口，
只处理 uncertain 执行，支持两种明确裁决：可信证明结果已确定时补录经过结构校验的正式回执；可信证明未发生外部副作用时，
将 Binding 置为 released 并结束执行保护。两种路径都必须同时通过独立 Authorizer 和 Evidence Verifier，不提供配置时默认拒绝，
不能通过 API 直接改状态、清空 uncertain 或依据旧 PID 猜测结果。

验证器返回的一等证据断言绑定完整调用身份、工具版本与 Contract/Input 指纹、Case/Run/Work、旧宿主 owner/lease、结果指纹、
清理状态、证据引用和有效期。控制面复查证据不能早于执行权更新时间，结果确认不能搭配“未启动”证明，无副作用确认不能搭配
“不适用”清理证明；验证结束到提交之间再次复查身份和执行所有权。成功处理在单个 SQLite 事务中写回回执或释放 Binding、结束
执行保护并写入审计，任一写入失败全部回滚。命令以请求指纹幂等重放，同 commandId 改参数会冲突拒绝；允许、拒绝、未评估和
证据拒绝均保留有界记录，成功断言只保存受信结构，原始 opaque evidence 只保存 SHA-256 指纹。数据库 Trigger 阻止对账审计被
更新或删除。

新增 16 项 SQLite 集成回归，覆盖结果补录、确认无副作用、安全释放和资源保护结束、命令重放/冲突、授权拒绝/异常/非法响应
fail closed、未知调用不触发授权或验证、身份/执行权/有效期/清理/结果伪证、非 uncertain 状态拒绝、结果形状错误、审计写入
故障事务回滚、验证后换主冲突和审计不可变。边界仍然明确：底座只定义并接线可信验证 Contract，不伪造某个平台的证明；部署
必须提供能够校验真实 Execution Node 或外部系统证据的 Verifier。对账本身不会自动重试 blocked Work；授权重试能力由下述批次
提供，不能复用旧调用键偷偷重跑。

第二十三批已完成 blocked Work 授权安全重试与 Execution Node 持久化执行观察。核对实现后修正原计划中的两个不安全假设：
“换新键重跑整个 Work”可能重复该 Work 之前已经完成的其他调用；“主进程退出”也不能证明整个进程树已停止。因此本批不宣称
原生可信清理证明已经完成，只交付可证明安全的重试分支和执行观察基础。

Core 新增 `retry_blocked_work` / `work_retry_authorized`：原 blocked Work 不改写，创建带 `retryOf` 的新 Work，保留旧事件，
使用新 Work id、幂等键和新租约；attempt 额度沿继承链延续、不重置，领取时增加。新任务不复用旧检查点和审批通行权。仅当前
运行中的 Run、当前 phase、未耗尽 attempt 且尚未派生重试的 blocked Work 可以转换。Server 控制 API 有独立默认拒绝的授权器、
授权有效期与 revision 复查；在同一事务里检查原 Work 的调用、生成重试事件、封住未启动 Binding 并写不可变审计，提交后才发布
调度通知。任何 executing/uncertain/旧版无账本调用、已有回执或未经可信“无副作用”对账的 completed 执行都会阻止整单重跑。
这是保守安全门禁，不因为工具自报 read-only 就假定无副作用；已有结果的任务不能从头重做。
独立续跑控制链已由下述 2026-08-31 批次实现，不放宽这里的整单重试条件。

Execution Node 协议提升到 1.5，新增可协商的 `process.execution_observation` 和经过现有认证 RPC 的精确请求查询。生产本地
节点接入 SQLite 执行账本，在 launcher 派发前原子登记 claimed；同进程并发启动被阻止，重启后同一键也不能再次启动。正常
退出或错误回调保存有界 descriptor/events 和事件丢失标志；写入失败则保留 claimed，不能伪装为可安全重试。记录只保存请求
哈希，不保存 environment 或进程 adoption token；存储摘要不一致时查询拒绝。查询绑定 request/idempotency/Case/Run/Work/lease，
保留原节点身份。缺记录返回 unknown；claimed、exit_observed、failure_observed 均保持 cleanup=unverified，不能直接拿来通过
对账验证器或回收保护。进程被收养而归属已变化时也不能用旧账本生成新归属证明。

本批新增 14 项重试集成测试、8 项执行账本集成测试和 1 项未来时间证据拒绝测试；扩展原有 6 个 SIGKILL 窗口验证节点账本跨
两个新宿主不丢失、不重复执行、不误报清理。真实子进程退出/数据库重开、claim/terminal 写失败、事件丢失、换租约查询、启动并发、
launcher 失败和损坏存储均覆盖。对账提交前再次校验证据有效期，并拒绝未来签发时间与“无副作用裁决”期间新出现的回执。
测试 launcher 仅提供测试 attestation，不证明实际沙箱与任意子进程树清理；现有 RPC 回归也已通过。持久化输出目前保留有界单次
事件但未实现全局保留容量治理，后续应保留去重 tombstone、独立裁剪输出，不能通过删除整条请求账本解除去重保护。

第二十四批已实现 Windows 原生执行的 owned-job 清理屏障和 PTY 完成协议，未将其提升为可信对账证明。
stdio/ConPTY 两种执行都显式终止 Job，并在五秒轮询期限内查询到 ActiveProcesses=0 才允许正常完成；终止失败、查询失败或
未清空均返回错误。stdio 在创建 suspended 子进程前创建 Job；绑定失败会显式终止未归属的子进程。ResourceMonitor 退出时
停止并等待监控线程，避免错误路径关闭 Job 后监控线程继续访问旧句柄。ConPTY 及时关闭重复管道端点，先清空 Job，再等待
控制线程、排空输出、回收 profile；控制线程在返回前失效化 Job 引用，输出读取异常不再被当成正常 EOF。

Windows helper 协议提升到 3，启动探测强制要求 jobEmptyBarrier，旧二进制需重新构建。PTY 完成消息增加每次启动随机 nonce，
只有 Job 屏障、输出排空和 profile 清理成功后才发送；控制器还须等 helper 正常关闭、退出码匹配、消息完整且没有后续帧才接受。
旧式退出帧、错配/非 ASCII 标识、重复完成、完成后输出、截断帧及 helper 异常均拒绝；终止 ACK 仍不是清理结果。Runtime
重放已缓冲回调时先登记错误和资源限制，再登记退出，避免已知失败被写成成功观察。

新增跨平台 Rust 清理状态机测试及 Windows Job 原生测试，并把原生测试接入 Windows helper 打包前门禁。当前 macOS 已运行
六项状态机测试，并完成 Windows 专用源码及测试的交叉编译检查；**未运行 Windows 原生测试、未完成平台隔离验收**。原生状态机、
Node 子进程协议回归和交叉检查各自证明不同内容，不得混称为 Windows 验收通过。详见 `docs/architecture/native-execution-cleanup.md`。
当前 nonce 仅绑定本次活跃 launcher，不是签名或持久化请求/节点世代证明；执行账本仍保持 cleanup=unverified，默认拒绝的
Verifier 不变。Job 外部委托副作用、继承句柄边界、完整双模式平台故障验收、启动/管道 watchdog、持久化清理报告与对账接线
仍为后续工作，不因为收到完成帧就解封 unknown 调用或回收它的文件。

第二十五批已实现生产 launcher 的宿主侧分阶段 watchdog，覆盖 PTY 与 stdio 的准备、启动、控制、执行和收尾等待。
默认准备/启动各 10 秒、控制与状态读取 5 秒、首次收尾信号后 10 秒，执行总期限使用请求 timeoutMs；所有配置校验为正整数且
不得超出 Node timer 安全范围。执行期限从 spawn 开始并覆盖收尾，最早到期者生效；重复终止、资源通知或完成消息不会续期。
普通 stdio 的启动确认仅是 OS spawn，不冒充原生目标已就绪；自定义 launcher 和阻塞的宿主事件循环不属于该保证。

管道写入等待实际 write callback；PTY 还须收到 ACK。最多同时追踪 64 个控制操作。管道提前关闭、写入堵塞、无 ACK、
终止适配器不返回、helper 发完完成帧不退出、root 退出后后代占用管道均受期限约束。超时先报告失败，尝试强制结束所持有的
child/helper 并关闭本地管道，清理 timer/监听和所有待定操作；null 退出只代表本地传输终结，不是实际进程树已清理证明。
Runtime 的计时器移到 closeInput 前，并避免对已缓冲终态再挂 timer。失败观察及启动阶段 claimed 均保持 cleanup=unverified，
晚到成功不会覆盖失败，SQLite 重开后原幂等键仍被阻止重新派发。异步准备迟到也不启动进程；底层 promise 无法取消时不声称已取消。

原生 Windows helper 同批提升为协议 4，新增 atomicJobAssignment 探测：stdio 改用创建时 Job List，消除“进程已创建但尚未
AssignProcessToJobObject 时 helper 被超时杀死”的窗口。旧 v3 二进制不允许与新控制器混用，需重建。ConPTY 关闭目标输入
只释放输入 pipe，不再结束控制线程，后续 resize/terminate 保持可用。新增 Windows 创建即归属测试并接入原有原生打包门禁；
当前仍仅完成 Windows 源码/测试交叉检查，三项原生平台测试与双模式真实隔离/故障验收尚未执行。

本批没有新增应用层规则，没有开放自动重跑或 native trusted Verifier。可信清理报告持久化、节点执行世代绑定、原生信任链、
profile 残留恢复及 Windows 实机验收仍是下阶段条件；宿主 timeout 不能代替这些条件。架构边界已同步到
`docs/architecture/native-execution-cleanup.md`。

**当前完整里程碑：执行异常恢复控制链已贯通。** 前述批次为历史记录，协议和当前剩余边界以本段及第 7 节为准；
后续按可验收能力交付，不再把单个字段、接口或测试补丁作为一轮开发的完成目标。本轮连续完成以下相互依赖的内容：

- 修正 Process Tool 到 Gateway 的失败语义：watchdog/null 退出、传输失败、事件丢失与游标停滞不会生成普通终态失败回执，
  而是保留 uncertain 和资源保护。已终态启动响应仍会排完事件分页，真实非零退出仍是正常失败结果。注册 class Adapter 时绑定
  execute 方法，避免复制描述符后丢失方法及实例上下文；真实进程端到端测试覆盖这条注册路径。
- Execution Node 协议 1.6、schema-2 账本在派发前持久化请求指纹、原归属/租约、节点 ID、节点执行世代与随机启动身份，
  终态落账不可替换这些身份；同节点 ID 重启也换世代。ConPTY 使用该启动身份作为完成帧 nonce。旧 schema-1 可查询但不能
  回填升级成可信证明；所有本地观察仍为 cleanup=unverified。
- 新增部署侧固定 Ed25519 公钥的恢复凭据验证器，校验来源授权、有效期/最大存活时间、撤销、调用/工具/输入/结果与执行归属，
  进程凭据还精确绑定账本 request/lease/generation/launch。凭据按内容寻址不可变保存，引用复用时重新核验当前信任状态。
  不接受请求自带公钥，不提供签发接口，不把本地超时/完成帧签成可信证明。进程签发者须由部署侧通过平台验收后显式授权。
- 通用组合根接入统一查询、recover 与 resume API。恢复命令先不可变登记，对账和重试各自使用确定性幂等子命令及独立授权。
  无副作用凭据核验通过后才允许授权新建 Work；可信结果原子补回回执，不允许整单重跑；重试被拒绝不会撤销已经提交的对账。
  中断后显式续办精确原命令，既不自动循环重试，也不悄悄换用最新 revision。未配置信任/授权时默认拒绝。
- 完成真实超时子进程→Gateway→SQLite→重启→凭据核验→对账→授权重试测试；新增注册后、对账后、重试后三处独立宿主
  SIGKILL 窗口，各用两个新进程续办，验证只产生一个替代 Work、一个对账审计和一个重试审计。补充凭据篡改、过期、撤销、
  跨归属、旧账本、权限拒绝、分页与事件丢失回归；共新增 47 项测试，全部纳入快速回归和底座门禁。

验收结论：异常调用不会被错误结清；可核验的结果能够补账；可信“无副作用”裁决能进入单次授权重试；恢复操作中断后不会重复
创建任务。这里的“完整”指上述控制链，而非全部生产条件已达标。Windows 原生签发者、独立清理报告通道、profile 残留处理与
双模式实机验收仍未完成；该批交付时已产生部分成功结果的 Work 暂不自动续跑，统一容量和分页也未完成。其后由下述批次补齐，
不能将历史缺口当成当前状态：当时查询仅给出至多
100 条命令摘要，长历史分页和长稳压测仍待补齐。详见 `docs/architecture/execution-recovery.md`。

**2026-08-30 后续已交付：执行取消与进程历史容量闭环。**

- Process Tool 消费 Gateway 的本地取消信号，取消后发出一次强制终止请求；启动响应迟到时仍清理对应进程，不再发送 stdin。
  输入/事件读取失败也进入清理尝试。清理请求等待最多 5 秒，失败不伪造回执；Gateway 仍保留 uncertain，不能将已发终止请求
  当成可信进程树清理。进程工具同时核验页面归属、严格连续事件序列、Base64/字节数和总输出上限。
- LocalExecutionNode 默认最多保留 128 个 resident process record；启动中的请求也预占名额，单次启动元数据限 128 KiB，
  每进程最多 64 个并发事件等待者。容量压力下只移出已成功落账、已终态且超过 60 秒保留期的记录；持久化失败、
  无 journal 或仍在运行的记录不能被移出。完整请求指纹改为哈希保存，不继续在进程记录中保留环境变量原文。
- SQLite journal 默认最多 10,000 个永久执行键、512 MiB 逻辑预算，每次启动前预留 8 MiB 终态观察空间；结果落账后按实际
  JSON 字节数结算。预留/落账写失败不释放未知调用；超出任一门槛拒绝新启动。旧数据库迁移对未决或异常记录保守预留，
  重复启动不会重置配额或擦除旧键。上述预算只覆盖 journal JSON，不是整个 SQLite 文件、WAL、凭据或回执的磁盘硬配额。
- 每次新 claim 前有界检查至多 32 条完成记录：只有 binding/execution 均完成、归属匹配、存在合法回执且默认已保留 24 小时，
  才裁剪 journal 的事件副本。保留 launch/lease/Case/Run/Work、进程描述、原观察 SHA-256 和裁剪时间，显式标记 lostEvents；
  不删除去重键、不改回执、不删证据或恢复凭据。无确认回执、uncertain、归属冲突与无效回执均受保护。
- 通用恢复控制面新增 `GET /api/security-tools/execution-history`：Case/Run 范围、keyset 游标、默认 50/最多 100 条摘要，
  同时返回 journal 容量状态；不返回原始输出、命令参数、路径或凭据。旧单调用恢复查询增加裁剪元数据。
- 新增 26 项回归，覆盖真实 Gateway 超时终止、迟到启动/写入/观察取消、清理失败、输出与事件异常、并发名额、
  旧库配额迁移、完成历史裁剪、未决保护、裁剪事务失败、容量拒绝、连续执行与两次重启后的旧键拒绝。

该批交付时的剩余边界：永久键达到 10,000 条会停止新执行，而不是无限期运行；需要后续受控归档/容量管理。
回执、恢复命令与签名凭据的统一预算由下述后续批次补齐；语义上下文压缩、head/tail 输出与 Artifact、部分成功 Work 续跑、
24/72 小时长稳及 Windows 实机验收仍未完成。
本轮未修改应用层、具体场景、发现验证规则，也未启用默认原生信任。

**2026-08-30 后续已交付：统一执行/恢复存储容量与安全续办。**

- 数据库初始化接入统一配额、永久键账本和增量计数器，覆盖进程 journal、工具回执、恢复命令、签名恢复凭据、对账审计、
  Work 重试审计六类记录。SQL 写入触发器覆盖正常回执与可信结果回填等不同写入入口；超额写入与计账一起回滚。
  原始回执/凭据/命令没有自动裁剪，禁止直接删除历史或通过 `INSERT OR REPLACE` 覆盖原记录。
- 执行池默认 1 GiB，恢复池独立为 512 MiB；回执和进程 journal 各最多 512 MiB，四类恢复记录各最多 128 MiB。
  回执最多 100,000 个键，进程 10,000 个键，四类恢复记录各 50,000 个键；新键最多 1,024 UTF-8 字节。
  这是指定记录的逻辑字节预算，不是整个数据库、WAL、Artifact 或 Vault 的物理磁盘硬限额；本节“凭据”特指签名恢复凭据。
- `beginExecution` 与执行权获取在同一事务内预留回执空间（默认每调用 8 MiB）。不足时保持 prepared，不派发工具；
  已有预留不会因后来达到上限而失效。成功回执按实际序列化字节结算，异常调用和写入失败保留预留，不释放未知副作用。
  只有可信无副作用对账及审计原子提交后才将预留转成零负载永久键，后续不能在该键写入结果或重复执行。
- 对账审计写满时，结果回填、调用状态与预算结算一起回滚；Work 重试审计写满时，新 Work 与事件一起回滚。
  恢复凭据存储失败不再伪装成“凭据不可信”的永久拒绝；逻辑容量返回 507，识别到的恢复存储暂不可用返回 503。
  恢复空间后可显式续办原命令，未完成阶段仍须通过当前凭据有效期与授权检查；已完成的对账/重试按原幂等记录重放，不自动换命令或后台重试。
- 新增 `/api/security-tools/storage` 只读容量状态、Case/Run 范围的恢复命令 keyset 分页；对账历史也改为有界分页。
  默认每页 50、上限 100；命令摘要不返回请求体、结果或签名凭据。保留旧单调用查询兼容入口。
  同步修复含可选 `undefined` 字段的恢复请求可能写出不可重放 JSON 的问题，登记前统一 JSON 表示。
- 旧库迁移保留既有超大记录，并为 executing/uncertain、缺执行账本等未确认调用保守补计预留；重启不清空配额、原回执或
  去重身份。已验证无副作用的历史保留永久键而不占结果负载预留。
- 新增 32 项专项，覆盖六类字节/数量上限、分池保护、执行前拒绝、预留兑现、配额与事务回滚、忽略重复写入/覆盖拒绝、
  凭据写失败、同命令安全续办、历史分页及旧库迁移。三个真实宿主 SIGKILL 窗口（预留后、回执未提交、回执已提交）
  各经两次新宿主恢复核验计数、回执与 SQLite 完整性，未用内存异常替身代替这些崩溃窗口。

该批交付时的边界：统一容量门禁已落地，但配额达到数量上限仍会拒绝新增操作；受控归档/回读、全数据库与文件系统容量治理、
部分成功 Work 的 checkpoint 安全续跑及真实长稳验收尚未完成。续跑由下一批次补齐；恢复池仍可能单独耗尽，分池不等于永远有恢复空间。
本轮继续冻结应用、场景、Skills/知识/MCP 内容装配，不改变授权、证据验证和默认原生信任状态。

**2026-08-31 后续已交付：部分成功 Work 的精确恢复与授权续跑。**

- Worker 在真正派发前先提交 v2 checkpoint，保存确切 invocation/input、工具 Contract 摘要、Case/Run/Work/工作幂等键、
  已完成调用和连续失败次数。保存或提交失败时不派发；结果已落库而结果 checkpoint 提交失败时仍保留原 pending 快照。
  派发前再次比对工具 Contract，避免等待 checkpoint 提交期间发生目录变化后执行不同版本。
- 该批 checkpoint 改为内容寻址的独立文件（单文件最多 1 MiB），随机临时文件、文件同步、原子 rename；非 Windows 平台同步目录。
  加载校验摘要、结构、归属与无损 JSON 输入。新快照不会覆盖旧已提交引用；生产 Worker 使用共享 checkpoint 根目录，
  旧 v1 路径保持只读兼容。该批未实现快照累计磁盘配额或孤儿快照回收；后续归档批次将生产新快照切换到有界 SQLite 存储，见下文。
- 恢复先核对 Work 的调用账本与 checkpoint，再处理保存的精确动作，不让模型重选：已有回执直接恢复结果；独立确认
  无作用的调用记入续跑进度但旧键仍封禁，不制造工具回执；确切从未启动的动作才按当前权限和原 Contract 派发。
  未决调用、缺失账目、归属/输入/Contract 不符均阻断。审批恢复也复用保存的输入，不要求模型重新构造请求。
- 新增 `POST /api/scenarios/runs/:runId/work/:workId/continue`，须指定原 checkpoint 引用和 expectedRevision，使用独立
  `workContinuationAuthorizer`，默认拒绝。Core 只接受通用 `continue_work` 生命周期命令，不认识具体安全场景。
  仅将 blocked/failed 的同一 Work 重新排队，保留幂等键、确认结果、审批记录和执行预算；存在活动租约、待审批、替代 Work、
  阶段变化或预算耗尽时拒绝。新租约不能复用 Run 历史中的任何 claim 租约。
- 准入核验、仅重新开放“已证明从未启动”的 pending binding、事件和续跑审计在同一 SQLite 事务内提交；沿用已有
  Work 恢复审计表/`retry` 容量池，指纹包含 `operation=continue`，与整单 retry 命令隔离。容量或 I/O 故障不留下假成功，
  也不写成永久授权拒绝，恢复存储后可续办同一请求。成功请求重复提交只重放原审计，不再次排队。
- 新增 47 项回归，覆盖不可变文件、摘要篡改/输入损失拒绝、工具版本变化、默认授权拒绝、精确审批恢复、账本不一致、
  预算与存储故障、旧租约拒绝以及三个真实 SIGKILL 断点（pending 已提交、回执已有但结果 checkpoint 未提交、结果 checkpoint
  已提交）。每个断点均由两次新宿主恢复，检查动作只执行一次、仅一个 Work、模型读取已恢复结果及 SQLite 完整性。

当前边界：安全续跑要求可验证的 v2 checkpoint；不能给缺失精确动作的历史 v1 任务猜造恢复点。旧快照自动恢复也须通过账本
完整性检查。预算耗尽不能借续跑重置；不承诺模型之后用新调用 ID 主动提出相同语义动作时也具有“恰好一次”语义。
该批提前解决续跑的正确性缺口，当时受控归档仍未实现；下述批次继续补齐归档/原引用回读和生产新 checkpoint 的累计容量治理。
Windows 实机、可信原生签发与 24/72 小时长稳未验收；应用和场景继续冻结，Skills/知识库/MCP 装配不在本轮新增。

**2026-08-31 后续已交付：七类执行记录的受控冷归档、原引用回读与有界生产 checkpoint。**

- 回执、进程记录、恢复命令、签名凭据、对账审计、重试/续跑审计和 checkpoint 共七类记录接入统一归档层。
  同一 SQLite 事务内保存压缩原文、改写活动负载为摘要引用、结算原容量计账并提交归档审计；保留原身份、归属和永久去重键。
  读取仍用原 key/ref，验证解压上限、SHA-256、归档身份与源记录投影；缺失或篡改直接阻断，不退回伪造结果。
- 新增独立 `executionArchiveAuthorizer`，默认拒绝。归档要求匹配 Case/Run/revision、Run 已完成或取消、默认保留至少 24 小时、
  无活动租约和未决/缺账调用；逐项验证 Work 归属、记录完整性和恢复命令阶段已结束。不能归档正在运行的任务来腾空间。
  单命令最多 32 项，解码源记录合计最多 16 MiB；成功命令重放只回读和核验，不重复改写。容量/暂时写故障返回 507/503，
  整批回滚且不留下永久拒绝审计；恢复空间后可显式重提原命令。
- 新增归档写入口及 Case/Run 范围的候选/历史 keyset 分页（默认 50、最多 100），摘要不含原始输出、凭据或授权材料。
  冷记录与归档命令审计共同计入独立的 1 GiB、200,000 条上限；冷存储满时停止归档，不能靠无界冷表绕过容量门禁。
- 生产 Worker 和显式续跑改用 SQLite 内容寻址 checkpoint：保留原 `checkpoint://sha256-...` 引用，文档最多 1 MiB，
  独立 512 MiB 池、100,000 个永久键，计入第七类存储。保存失败仍在工具派发前停止；相同内容重复保存不重复计账。
  历史文件只读兼容，不自动导入或删除；旧文件及崩溃遗留临时文件仍未纳入新配额，须后续盘点与受控治理。
- 现有恢复/对账/重试/续跑、凭据核验和进程历史读取均走归档回读。归档不跳过当前凭据信任/有效期检查，不生成新 Work，
  不重置预算，不允许旧执行键再次使用；已提交命令仍重放历史决定。原生可信签发、Finding 证据门禁和 Scenario/Core 边界不变。
- 新增 30 项回归：七类原文回读和防改写、防替换、防删键，终态/保留期/归属/未决准入，损坏拒绝，冷容量与事务回滚，
  checkpoint 满额执行前拒绝和部分成功恢复；三个真实 SIGKILL 窗口覆盖冷记录已写未提交、活动记录已替换未提交、整批已提交，
  每个窗口均由两个新宿主验证原结果、引用、计账和命令重放。

当前边界：这是**同库逻辑冷归档**，不是离线备份、物理数据库收缩或全磁盘配额；小记录压缩后不保证节省总空间。
归档释放活动负载，但永久键仍保留并计数，达到键上限仍拒绝新执行；冷存储本身也有上限，不能承诺无限运行。
该批交付时 SQLite/WAL 物理观测、旧快照迁移/清理尚未完成，由下面的可靠性整批交付补齐受控主链；
全卷配额、永久键长期规模扩展和实际 24/72 小时长稳仍未完成。

**2026-08-31 后续整批已交付：物理存储准入、可恢复维护与连续组合可靠性验收。**

- 文件数据库新增主库/WAL/SHM 大小、SQLite 页/可复用空间和文件系统可用字节观测。新执行默认保留 256 MiB 余量，
  并计入现有回执预留及新条目的双倍写入余量；恢复写入使用独立的 32 MiB 余量。主库加 WAL 默认 8 GiB、WAL 默认 256 MiB
  触发新准入限制。探测失败则拒绝新准入，状态不泄露宿主路径；内存数据库明确标为不计物理容量。
- 准入检查下沉到 SQLite 新预留、进程 claim、checkpoint 和恢复/归档源记录写入触发器；不足时工具仍未派发，调用保持 prepared。
  已有结果预留及进程结算不因后续新准入压力被撤销。观测余量不是物理块预分配，其他写入者仍可能耗尽空间，不能承诺永不写失败。
- 新增独立 `storageMaintenanceAuthorizer`，默认拒绝。WAL 的 PASSIVE/TRUNCATE 维护先持久化意图，等待锁最多 50 ms；
  有读取者阻止完整回收时返回 503，保留原命令待显式续办，不杀读取者、不自动 VACUUM。维护后审计自身仍可能写出少量 WAL。
- 旧 checkpoint 盘点最多 2,000 项、最多一层 Worker 子目录，明确完整/截断和不可处理条目。共享根目录中内容寻址的 v2 快照，
  以及内容完整且摘要匹配的 UUID 临时快照，可受授权迁入 SQLite，保留原引用并计入既有配额；原文、归属和迁移阶段原子提交后，
  才能按请求移除旧文件。移除要求默认 24 小时保留期、无活动 Work 租约，写锁阻止新租约穿过清理窗口。
  unlink 后审计未提交即崩溃，也可从已提交的 imported 阶段恢复；不存在先删唯一副本再补登记的步骤。
- 源文件读取有大小、摘要、无损 UTF-8、inode/设备和稳定元数据检查，拒绝路径越界、符号/硬链接及不可信根目录。
  v1、未知或不完整临时文件保留，不按年龄猜删；维护根必须由可信宿主独占，不能与旧版文件写入进程或非可信工具共享写权限。
  维护命令永久保留，上限 10,000 条，每条请求/结果各最多 4 KiB、授权引用 1 KiB，不形成无界审计表。
- 新增 `verify:reliability`：只创建独立测试目录，通过中性本地工具把“物理拒绝 → 结果保存/快照失败 → 冷容量耗尽 →
  归档 → 强杀 → 两个新宿主恢复 → 旧键拒绝”放入累计数据库连续验证；另一路常驻进程复用模块持续执行，采样 RSS 上限 512 MiB。
  支持 24/72 小时参数、有界报告、子进程截止时间和中断记录；运行报告保留实际轮次/时长，未跑满时不冒充长期通过。
- 新增 44 项测试全部纳入底座门禁：其中真实 SQLite 页上限触发 `SQLITE_FULL`、读取连接钉住 WAL、三个旧快照迁移强杀窗口，
  以及三轮完整组合恢复与常驻进程回归均已覆盖。更新旧库迁移夹具，使其真实还原为不含新增触发器的历史 schema。
- 本机短时连续验收实际运行 120.826 秒通过：74 轮故障循环、296 次短宿主运行、74 次 SIGKILL；常驻进程完成 234 轮。
  常驻进程采样峰值 RSS 165,576,704 字节，短宿主采样峰值 193,249,280 字节。验收入口、操作边界及本机报告位置见
  [存储可靠性与验收说明](architecture/storage-reliability.md)。没有对用户的实际历史快照执行迁移或删除。

本整批完成的是可运行的存储可靠性主链与组合验收工具，不是无限容量或生产发布认证。物理观测不能覆盖所有写入者，
未知历史文件保留、永久键/冷库满额停机、全状态迁移需保留恢复身份等限制已写入操作说明；跨库分片/离线导入导出尚未实现。
真实 24/72 小时、真实文件系统耗尽/断电、完整生产宿主长期负载和 Windows 双模式实机/可信原生签发仍是独立发布门槛。
应用、场景和 Skills/知识库/MCP 内容装配继续冻结，不因短时测试通过而解锁。

**2026-08-31 后续整批已实现：完整底座宿主接线验证与恢复/超时缺口修复。**

- 新增中性生产组合夹具：真正监听 TCP 的 Foundation Host、HTTP 控制面、嵌入 Worker、自动调度、
  StructuredWorkerModel、模型准入/快照、磁盘 SQLite 和真实 RPC 子进程 Provider 一起运行；不是只用进程内伪控制面。
  模型返回由确定性测试端口提供，Provider 使用显式 test-only 非沙箱启动，不代表外部模型或原生隔离已验收。
- 修复启动竞态：嵌入 Worker 仅在启动恢复链完成后注册/接任务；运行时查询暴露 startupState。关闭先停止新调度、
  等待启动链，再排空 Worker 和工具来源，避免迟到激活重开 Provider。ready 表示启动链完成，不表示所有 Provider 健康；
  单来源失败仍服从 Discovery 原有隔离。任意外部注入、永不返回的 Discovery 实现仍可能阻塞启动/关停，尚无统一强制终止机制。
- Worker 新轮次身份加入编码后的 Run、Work、Worker、lease 和 attempt，隔离跨 Run 同名任务及同 attempt 的新租约评估。
  不重写旧事件/检查点身份；恢复使用原引用，工具幂等键不随新评估身份变化。
- 修复调度器与 Core 不一致：已授权 checkpoint 续跑不增加 attempt，耗尽普通重试额度后仍可领取；未授权任务仍拒绝，
  能力、租约、phase/Worker 容量约束不放宽。真实 HTTP 测试验证结果检查点失败后重建宿主、以及模型失败后续跑，都不重派已确认动作。
- Worker HTTP 客户端默认 10 秒覆盖响应头和响应体，请求上限 1 MiB、响应上限 4 MiB，拒绝重定向及非法 JSON，
  流式实收字节也受限，错误摘要最多 1,024 字符；可注入有界配置（时间至多 60 秒、大小至多 16 MiB），不隐式重试写命令。
  原生 fetch 接受 AbortSignal；自定义 fetch 实现必须遵守取消契约。403/404/409 的合法错误响应保留租约丢失语义。
- 模型运行时现在自行竞速等待截止/取消，不依赖 Provider 主动 reject；迟到结果和 usage 不再改写已结束记录。
  Run/Work 取消和宿主 shutdown 均覆盖忽略信号的模型端口。不等于远端推理已停止或停止计费；
  无法强制终止任意同进程实现或阻塞事件循环的同步代码，真实工具执行仍遵守 uncertain/独立对账边界。
- 本批新增 33 项测试：11 项完整宿主组合、16 项真实 HTTP 传输、4 项模型截止/取消、2 项调度边界。
  完整宿主覆盖正常执行、跨 Run、两条续跑、容量拒绝、Provider 崩溃、非法模型/模型超时、零包、启动期关闭及在途模型关闭。
  已纳入独立底座门禁；单个组合测试使用短截止，不启动 24/72 小时长跑。

本批完成的是已有通用底座的真实组合接线与故障修复；尚未实现语义压缩、统一用户取消到全部工具进程、
Skills/知识资源/MCP 的通用装配，也未完成真实多日负载、实机文件系统耗尽或平台隔离认证。

**2026-08-31 验收补充：真实模型联调入口已实现，真实模型验收尚未执行。**

- 新增显式 `verify:foundation:model --allow-model-api --config <配置路径>`，使用已有生产模型 Adapter，不提供 mock 回退；
  缺配置或未明确允许调用时以退出码 2 返回 `not_run`，不算通过。只使用所选主模型，不自动调用备选模型。
- 验收分正常执行和检查点失败后宿主重建两条链。随机观察值只在中性工具子进程内可见，模型必须自主选择工具、接收结果，
  并在完成摘要中返回实际观察值；不调用工具、凭空完成、漏掉观察值或重复调用均失败。续跑须保留同 Work/attempt 并从回执恢复，
  重启后不得再次调用工具。没有接入真实安全目标、应用层或具体场景，也不以空安全输出冒充发现验证。
- 报告保留模型身份、请求/响应指纹、结果/观察值指纹、耗时、实际报告的 token 用量、快照/检查点/回执数量和数据库完整性。
  上游错误原文不写入报告；无 usage 时记录 null。先写失败/incomplete 状态，用户中断后排空并记录失败，禁止把未完成运行算成功。
- 默认最多 6 次逻辑模型调用、120 秒工作期限、单次 30 秒；请求序列化上限 128 KiB、返回 JSON 入库前上限 64 KiB。
  SDK 内部 HTTP 重试/格式回退可能多于逻辑调用数，清理可能另耗时间；这不是输出 token/费用硬额度，也不证明远端停止计费。
- 新增 14 项离线回归检查验收器本身，含生产 Adapter 对接本地模拟 API、随机观察值校验、重启续跑、假完成拒绝、次数/时间/中断、
  异常脱敏与 CLI 缺配置拒绝。报告明确标记 `simulated_harness_test`；这些通过不代表真实模型通过。
- 实际执行 CLI 的结果为 `not_run / model_configuration_missing_or_invalid / modelApiCalls=0`。
  项目模型配置及已检查的桌面配置/模型环境变量均不可用；用户随后明确要求先跳过，后续提供配置，现记为“暂缓、未执行”，不阻塞后续底座开发。
  **真实模型联调仍待完成，不能宣称底座已通过模型端到端验收**。
  入口、记录及限制见 [真实模型验收说明](architecture/foundation-model-acceptance.md)。

开发内容：

- Provider 进程采用指数退避、抖动、失败预算和 quarantine，避免崩溃重启风暴。
- ~~持久化发现 revision、最后成功目录、最新健康结果和有界故障原因。~~ 已完成。
- ~~将 Provider 日志与模型上下文彻底分离，只保留有界诊断和审计引用。~~ 已完成。
- ~~增加按 Provider、工具、Run 和 Work 的并发配额与公平调度。~~ 已完成。
- ~~建立 Provider 升级兼容检查、调用级版本固定、原子准入围栏和工具 Schema 差异审计。~~ 已完成。
- ~~建立确定性签名归档、离线发布命令和受限 staging 安全解包。~~ 已完成。
- ~~将归档导入接入鉴权控制面、安装审计和 staging 清理，并关闭默认本地目录安装旁路。~~ 已完成。
- ~~提供受授权、可审计、失败保留旧目录的显式 Provider 刷新 API。~~ 已完成；刷新不得改变签名目录。

验收条件：连续崩溃不会拖垮主进程；坏版本自动隔离；健康 Provider 和正在运行的 Work 不受无关来源故障影响。

### P1：Linux 可证明执行后端

当前状态：严格 Host Contract、Linux Rust helper、DEB 安装/卸载/升级回滚接线和 fail-closed Desktop 装配已完成。底座只识别 TraceForge Linux native helper，
完整核对 namespace、cgroup v2、seccomp、`no_new_privileges`、文件/网络/资源与进程树屏障探测，并在宿主启动和每次执行之间固定 Helper
SHA-256；替换或证明缺项均关闭执行。DEB 以固定 root-owned 路径安装 helper/manifest 和 AppArmor Profile，当前登录用户经瞬态 `Delegate=yes` systemd user scope 启动，不创建远程节点或系统 daemon。便携/直接启动明确关闭进程能力。helper 已实现原子 cgroup 归属、独立 namespace、最小文件根、capability 清除、受控环境、
资源监督、进程树清空以及 stdio/framed PTY。Ubuntu 24.04 x64 已保留协议 1/16 类历史证明；当前协议 2/19 类矩阵、第二发行版/内核与正式安全审计尚未完成，因此仍不能签发当前版本的生产平台证明，也没有普通 `child_process.spawn()` 回退。

开发内容：

- ~~建立独立 Linux native helper 的严格 Host Contract 与能力探测，明确内核、cgroup v2、namespace、seccomp 等强制约束，
  不把“命令成功启动”等同于“策略已执行”。~~ 已完成；当前使用 mount policy，Landlock 仍只是可选后续增强。
- ~~固定 CPU、内存、进程数、写入字节、文件系统可见范围、网络模式、进程树屏障和请求 Profile/资源指纹的 enforcement Contract。~~
  已完成；平台侧生成这些事实的 native 实现仍待验收。
- ~~实现 Linux native helper 源码、framed PTY 与 Linux-only 打包/真实 probe 门禁。~~ 已完成；当前协议 2 的目标发行版构建产物、可复现性和 19 类实机矩阵待执行。
- ~~使用独立 user/pid/mount/ipc/uts/network namespace、受控工作目录和最小 capability；不允许继承宿主敏感环境变量或凭据。~~ 已完成源码与契约，待实机对抗验收。
- ~~明确 rootless user namespace + 受管 cgroup delegation 的安装边界、发行版配置与升级撤销；缺少某项强制属性时继续按能力关闭。~~ 仓库实现已完成；正式 Linux Desktop 为 DEB-only，实机安装/卸载/失败升级验收待执行。
- 逃逸、资源耗尽、孤儿进程、helper/上层宿主崩溃与启动恢复已有协议 1 的 Ubuntu 实机覆盖；仍需在协议 2 重跑并补不受支持内核、第二发行版和 Windows 对应矩阵。

验收条件：Linux 后端只能在所有声明约束均有可验证证明时返回成功；Provider 和工具无法绕过网络、
文件系统或资源策略；不满足生产策略的主机明确报告 unavailable，且不存在直接 spawn 回退。
详细边界见 [本机原生 Execution Node 信任边界](architecture/local-native-execution-node.md)。

### P1：将 Runtime 从 `apps/server` 提取为可复用 packages

当前状态：已开始逐片提取。实际依赖图记录在 `docs/architecture/runtime-dependency-map.md`；当前 Server 有
166 个非测试生产文件，按直接 import 粗查 46 个依赖 Fastify、107 个依赖 SQLite/Drizzle 或数据库模块。
`@traceforge/model-runtime` 的 Admission 与 Execution slices 已落地，目标仍是让 Server 回到 Transport、Adapter、Persistence Wiring
与 Composition Root，而不是简单追求目录变小。

阶段 A：依赖图与 Ports

- 为 Scenario、Cognitive、Model、Evidence、Tool 和 Execution 六层绘制实际 import 图，标出领域逻辑、端口、
  SQLite/Fastify Adapter 与 Composition 代码；先消除循环依赖，再决定包边界。
- Runtime 通过 Store、Clock、Event Writer、Model Provider、Execution Node、Tool Registry 等显式端口工作，
  不直接 import Fastify、具体数据库 client、桌面 API 或某个 Scenario Package。

进度：依赖图和模块分类已落档；原 `llm → extension → reasoning-core → llm` workspace 循环已拆除，
模型 Provider Contract 由 `llm` 唯一持有，`extension` 仅兼容转导类型并拥有工具 Contract，两项无源码引用的
package 依赖已删除。Model Admission/Execution 已定义 Store、Event、Admission 和 Provider 端口，Runtime
不再直接依赖 Fastify、SQLite、Server 内部类型或 `llm`/`extension` 实现包。

阶段 B：按稳定职责提取

- `scenario-runtime`：通用 Run/Work/Lease/Checkpoint/Recovery、Definition Registry 与调度协议。
- `cognitive-runtime`：通用 Planner/Observer/Worker Loop、上下文蒸馏与认知快照协议；具体策略由 Scenario 提供。
- `model-runtime`：模型路由、Admission、预算、重试、熔断和调用审计协议。
- Evidence、Tool 和 Execution 继续复用现有 packages；只有在职责和依赖证明确有需要时再拆分或重命名，
  不为追求对称目录制造空壳包。
- `apps/server` 保留 HTTP/WebSocket Routes、配置、SQLite 实现、进程生命周期和显式装配。

进度：新增 `packages/model-runtime`，承接模型角色/调用上下文、资源策略、准入、Provider 路由、预算协议、
重试、熔断、超时/取消、调用生命周期及 Store/Event/Provider 端口。Server 的 Admission/Execution 文件现只保留
SQLite Adapter、row 映射和 Fastify 查询路由，并兼容原有导出；SQLite 事务仍负责原子预算预留。

新增 `packages/cognitive-runtime` 的两个稳定切片。第一片承接 Run/Evidence/Worker 上下文预算、确定性裁剪、
遗漏清单和语义指纹，Planner、Observer、Structured Worker 已直接消费；Server 原蒸馏文件只保留 SQLite cursor Adapter。
第二片承接认知快照 Prepare/Complete/Fail/Recovery、幂等输入/输出校验、请求指纹和 replay 编排，并定义
Persistence/Event/Model 端口；`SqliteCognitiveSnapshotStore` 只实现持久化与实时事件映射。该 package 不依赖
Fastify、SQLite、LLM Provider 或具体 Scenario。第三片新增 `CognitiveEvaluationRunner`，统一快照准备、模型调用、
决策解析和完成/失败编排；Planner、Observer、Structured Worker 只注入模型路由、Prompt、Schema 和完成策略，
不再各自维护生命周期。第四片迁移 `BlackboardChangeBus`，新增 Cursor Port 与 `CognitiveWakeGate`，统一 durable/
volatile 语义去重，Observer 删除自身的游标分支。第五片新增 `CognitiveLoopScheduler`，统一 wake 合并、
单 tick 所有权、停止排空、正常轮询和错误退避；Planner 与 Observer 只注入 tick、下一轮询间隔和错误处理，
不再各自维护定时器状态机。第六片新增 `projectRunContextLineage` 与 package-owned `assembleRunContext`，在无
Fastify/SQLite 的 Runtime 中完成失效来源、重试后代、指令、输出和证据图的保守投影，并固定先投影后压缩；
Server 只保留 Tool Receipt、Package Context、Snapshot 和 derivation SQLite Adapter，旧私有装配模块已删除。
第七片把 Planner/Observer 的 Run 枚举、Prompt、决策 Schema、合法性校验、语义去重、模型快照监督、循环调度、并发重试与幂等命令应用整体迁入 package，并以 Event/Graph/Evaluation/Model/Context Ports 隔离宿主；Server 的两个文件只保留 SQLite Store 和 Fastify 查询路由，Composition 直接装配 package 类。第八片继续迁移 Structured Worker 的提示词、决策 Schema、上下文裁剪/压缩、模型快照、取消检查和授权复检；Server 原实现文件删除，Embedded Worker 直接消费 package。工具副作用、租约、Checkpoint 和结果提交仍归 WorkerHost。

阶段 C：多宿主验收

- 建立不依赖 Fastify 的 Runtime integration harness，证明 Run、Planner/Observer、Worker 和 Tool Gateway 可直接组合。
- 增加最小 CLI/测试宿主，只依赖 packages 和端口实现，不 import `apps/server/src/*`。
- 增加 package dependency-boundary 测试和循环依赖检查，禁止 Runtime 反向依赖 Server、Desktop 或 Scenario 实现包。

进度：Model Runtime 的内存 Store/Provider harness 不依赖 Fastify、SQLite、LLM 实现或 Scenario Package，已验证
优先级、Run 级并发、Provider 回退、熔断、预算和超时；原 SQLite 集成测试继续覆盖记录、事件顺序、取消和
重启中断恢复语义。Cognitive Runtime 的无 Server harness 验证上下文裁剪、遗漏统计、语义指纹稳定性、预算拒绝、
快照幂等冲突、终态保护、重启中断、replay 成败审计、模型/解析错误的统一失败落档、Blackboard listener
故障隔离、consumer/run 级语义游标去重，以及 wake 风暴合并、无重叠 tick、停止排空和失败退避。
底座边界扫描自动覆盖新 package，并会构建 workspace 依赖图拒绝任何 package 循环。新增独立
`@traceforge/agent-runtime`，`AgentSession` 已接管回合预算、取消检查及 Model Intent → 可审计记录 → Observer
的固定顺序；`WorkerHost` 保留租约、所有权、恢复、工具效果/checkpoint 和控制面协调。框架级 integration host
不依赖 Fastify、SQLite 或任何 Scenario 包即可完成带证据引用的 Work。

验收条件：Server 仅承担 Adapter 与 Composition 职责；核心 Runtime 可在测试宿主或未来 CLI/Coordinator 中
复用；删除 Fastify 路由不影响 Runtime 包构建；包拆分不改变 Run/Event/Evidence 的持久化语义和重放摘要。

合并门禁：

- 每次只迁移一个有清晰端口的 Runtime slice，并保持公开行为、事件 schema 和测试基线不变。
- 新 package 必须至少有两个消费者或一个明确的非 Server integration harness；否则先保留模块边界，不创建空壳包。
- 禁止 Runtime package import `apps/*`，禁止 package 之间形成环，禁止为了消除类型错误复制领域模型。
- SQLite 查询与 Fastify request/reply 类型不得泄漏到 Runtime public API；Adapter 负责转换。
- 提取完成后删除 Server 中的旧实现，不长期保留双写、双运行时或兼容代理层。

### P1（当前底座里程碑）：Brokered Browser Execution

开发内容：

- ~~通过 Execution Node 启动浏览器进程并验证沙箱证明；逐请求 HTTP Broker、租约冻结、下载 Artifact 与有界审计。~~ Core 已完成，生产装配仍关闭。
- ~~实现 Host/进程双向协议、可度量身份握手、CDP Target auto-attach、脚本释放前 Fetch 拦截、popup/iframe/worker 接管、Service Worker 关闭、磁盘下载禁止和断线/迟到响应隔离。~~ 已完成。
- ~~实现真实 Chromium `--remote-debugging-pipe` FD 3/4 transport、固定参数/环境、浏览器摘要与运行版本复核，以及 Controller/Browser 双材料发布身份和启动装配合同。~~ 已完成；真实发行 bundle/Chromium 打包与平台集成验收仍待执行，WebSocket 在完成有界双向 Broker 前保持阻断。
- 在通用宿主端把浏览器 Session 与授权身份、Artifact/Evidence 和租约绑定；Cookie、Traffic 与登录流程仍由后续 Web Scenario Adapter 负责。
- ~~支持 DOM 快照、稳定元素引用、页面差异蒸馏、截图 Artifact 和人工接管后恢复。~~ 底座协议、Artifact 验真、动作围栏和人工通道已完成；应用人机界面留到应用阶段。
- 不引入 Burp 依赖，也不提供直连回退。

验收条件：浏览器无法绕过授权代理；身份撤销或租约过期立即冻结会话；人工接管后 Worker 能从持久化状态继续。

### P1（当前场景主线）：Web 黑盒 Scenario Package 闭环

开发内容：

- 建立授权资产、端点、参数、身份、页面状态和业务流程图谱。
- Research Worker 生成互相独立的 Hypothesis 与后续 Work，避免单一路径占满预算。
- Validation Worker 采用基线、变量控制、重复验证、反事实和影响确认形成因果证据链。
- 增加身份/权限矩阵、工作流状态覆盖、错误与差异聚类、受控回调服务和覆盖缺口评估。
- Report Worker 只从 verified Finding 和完整 Evidence Chain 生成结果。
- 漏洞知识、测试模板和 Payload 作为可版本化 Web 工具包管理，不写入底座调度器。

验收条件：在多个授权测试应用上完成无人值守探索、人工门禁、因果验证、失败回溯和可复现报告；不能把扫描器单一命中直接升级为漏洞。

### P1（应用层暂缓）：统一运维控制台

开发内容：

- 展示 Planner、Observer、动态 Worker、Work 租约、Evidence Graph、模型预算、Provider、Execution Node 和审批状态。
- 支持 Provider 排空/禁用、Work 取消/重试、Run 暂停/恢复、审批处理和证据回溯。
- 凭据面向有权限操作者可查看和使用，同时提供字段级权限、显式审计和安全展示策略。
- 所有界面操作调用控制面 API，不直接修改数据库投影。

验收条件：操作者能够从一个界面解释“当前为什么执行这个动作、用了什么权限、产生了什么证据、谁批准了什么”。

### P2：长稳、发布与未来扩展接口准备

开发内容：

- 24/72 小时 soak test 入口已建立；实际超长运行按用户要求暂缓，不阻塞后续底座开发。继续保留有界故障注入、重启恢复和磁盘/内存/模型故障测试。
- 完成 Windows 桌面发布包、原生 helper 和 Provider 包的签名、升级及回滚验证。
- 定义 SQLite 单机容量边界；不为尚无产品需求的 PostgreSQL、持久化队列或远程 Execution Node 提前建设迁移实现。
- 建立场景级评测集：探索覆盖率、无效动作率、循环率、验证准确率、证据完整率、人工介入率和单位发现成本。

验收条件：发布包在干净 Windows 环境独立安装运行；升级和崩溃不破坏 Run、Evidence、Approval 和 Provider 状态；关键指标具备稳定基线。

### 后续独立 Scenario Packages（底座验收后解锁）

底座仓库门禁通过后，各场景按独立包推进，不再通过修改 Core 增加场景：

- 白盒代码审计 Profile：仓库快照、增量 Diff、AST/语义索引、Source-Sink 数据流、验证与修复证据。
- 红队横向 Profile：PTY、远程 Session、跳板与隧道、凭据实体、网络拓扑以及更严格的审批策略。

这些场景不会复制底座，只通过 `ScenarioPackage` Contract 注册自己的 Profile、Worker 策略、
授权策略、输出 Schema、图谱映射和工具 Provider。当前只推进 Web 黑盒；白盒与红队场景继续保持未开发，彼此不构成代码依赖。

### 2026-08-31：Skill/知识文本与受控 MCP Tools 组合交付

已落地：SDK 显式 context metadata；精确 Package/digest/元数据指纹的不可变 SQLite 文本库；按 Work/Scope/阶段筛选的
`context.catalog` 与分页 `context.read`；持久化撤销；回执/检查点/模型请求快照中的来源与信任信息。
内容以 Host 显式安装为入口，单资源 64 KiB、内容库 8 MiB/2048 条、撤销键 8192 条；超额事务回滚，安装接入物理空间准入。
不自动读 locator 指向的路径/URL，不内置安全技能或知识。已撤销内容拒绝新读，历史回执/快照仍保留。

MCP 已通过新的 Host 配置接入 Discovery/Gateway/Execution Node；固定 2025-03-26 stdio Tools 子集，
每次发现/调用独立进程、重复核对身份/Schema、忽略远端权限标签、保留 Host 输入校验与目标授权、高风险审批及不确定调用恢复。
无 Node/隔离证明、Schema 变化、输入或目标越权、进程清理无法确认时拒绝。服务端协议错误不回传敏感明细，
ping 仅返回空协议响应，不协商 sampling/roots/秘密或反向执行能力。没有启用原先 extension 的无隔离直连方式。

47 项新增离线回归（25 资源、12 MCP 宿主、10 MCP 协议）已进入底座门禁，包括真实 HTTP Worker/SQLite/快照/恢复接线。
模型使用确定性决策；MCP 节点为协议模拟器，不能替代原生沙箱或真实 MCP 部署验收。已确认调用在宿主重启后不重复执行。
本批当时未覆盖 Skill 独立输入/输出及评估、知识检索、历史上下文撤销过滤、资源包导出/回收、MCP Resources/Prompts/HTTP/热更新；
其中包内检索与 Worker 历史资源过滤已由下面的续批完成，其余仍为缺口。
详细实现、容量、保留及信任边界见 `docs/architecture/context-and-mcp-assembly.md`；应用与具体场景继续冻结。

### 2026-08-31 续批：授权检索、资源有效期与 Worker 当前上下文

已实现 `validFrom` / `expiresAt` / 显式 `conflictsWith` 校验和选择策略；无效、过期、撤销、无权或当前明确冲突的资料
不进入可读集合。新增 `context.search`：仅检索当前 Work 有权使用的精确包，最多 256 字符/8 词，按字面匹配排序，
返回摘要而非正文；分页绑定选择指纹，权限或版本变化后拒绝旧页。使用现有有界文本库，不宣称建立语义/向量知识库。

新增通用 `WorkerModelContextPolicy` 及 Server 实现，并接入真实 Embedded Worker。Runtime 为工具观察写入 Host 生成的
`receiptKey`，模型输入从同 Case/Run/Work 的回执重建资源文本，逐轮复核当前包、授权、阶段、新鲜度、冲突和完整性。
无效正文/摘要及其后的模型/观察器笔记不进入新请求，旧 steering 与进度/错误/审批说明副本清理；新快照记录过滤清单，
旧快照、回执和恢复检查点不修改。兼容旧观察只做同 Work 有界账本查找，不凭原始文本或伪造引用授予信任。

Model Runtime 在排队获得配额后、实际发送前复查投影；变化时拒绝旧请求，不切模型绕过、不触发 Provider 熔断，
校验本身超时也不能迟到发送。含资源历史的原样快照重放返回 409，审计原件仍可读；为长快照 ID 增加有界查询/请求体入口，
不修改应用 UI 或全局路由配置。资源工具合约升为 2，旧在途合约变化仍需遵守恢复门禁，已确认动作不重跑。

本轮新增 31 项回归：25 项资源/投影/真实 HTTP 撤销与重启恢复，4 项发送前 Host 检查，1 项检查点溯源，
1 项模型投影变化拒绝。针对性 100 项通过，完整回归和独立编译见质量基线。
单轮最多处理 512 条历史观察，旧格式最多查 256 个资源回执；每次投影共享一次授权资源选择，避免按历史条数重复扫描整个包。
复用现有账本索引和有界快照，不新增无界审计表。

边界：只处理已识别资源观察与派生笔记，不是通用污染/信息流追踪；不能移除任意外部 Tool/图谱/用户输入再次引用的所有副本，
不能撤回已发给 Provider 的请求，也未自动取消已在执行的模型响应。本批当时未覆盖的 Skill 契约、固定 MCP Resources/Prompts
和单资源导出/退役已由下述续批承接；跨角色结构化 lineage 及有界摘录生命周期也已由后续批次交付。
后续已补齐 context-only 完整资源集合的签名导入，完整语义压缩及混合资产/可执行包迁移仍未完成。
真实模型与平台隔离验收继续暂缓，未添加具体安全场景。

### 2026-08-31 续批：Skill 契约与外部上下文统一装配

已实现可选的独立 Skill 输入/输出记录契约及最多 16 项机械完成条件，通过 `context.skill.prepare/evaluate` 在 Gateway 内
准备、校验和留回执。评估必须引用同 Case/Run/Work 已完成的成功准备回执，核对当前资源/契约指纹和授权；
新增两种动作须独立授权。未知字段、类型/预算错误、无准备或失效资料拒绝，不靠模型提交的副本授予信任。
结果只描述契约匹配，固定 `findingVerified=false`；没有执行脚本、改变证据验证生命周期或自动判定真实安全效果。

新增 Host `mcpContextServers` 与 Package `context.external`：固定服务器/审核配置指纹、资源 URI 或 Prompt 名称/参数和内容 digest。
通过现有 `context.read` 按需启动 Execution Node，完成对应目录/读取握手，读取前、发送前和响应后复查授权。
仅接受精确 URI 的单文本或最多 32 条纯文本 Prompt 消息；Prompt 角色留在资料 JSON 内，不能注入系统消息。
内容变化、错误 URI、二进制、缺目录、断连/超时、缺隔离证明阻断，不缓存未确认结果；进入外部调用路径后的异常沿用
uncertain/对账门禁，阻塞 Work 而非自动重试。成功清理后才入原有有界文本库，再复用撤销投影、分页回执与重启恢复。
已确认动作在重启后不再请求 MCP，跨 Run 使用独立归属进程；`context.catalog/read/search` 合约升为 3。

新增默认拒绝的 Host 管理入口 `POST /api/scenarios/context-resources/lifecycle`：精确身份/授权导出单条已加载资源，
或在该包无可恢复 Run 时退役并回收正文缓存。failed/blocked/paused 等不算可回收；退役标记、审计与删除原子提交，
写入失败全部回滚。每次导出重放重新授权和读取；退役重放幂等。原始回执/快照/检查点永不随缓存删除，不能通过重装复活退役版本。
管理账本/永久退役键各 2048 条，审计接物理准入，满额拒绝操作且不删旧账；不新增无界记录，也不自动 VACUUM。

本轮新增 48 项回归：SDK 契约 14 项、MCP 协议 6 项、Skill/生命周期组合 13 项、外部上下文真实 HTTP 15 项。
模型仍为确定性测试替身；MCP Node 为协议模拟器，不是原生沙箱实机验收。完整构建与回归结果见下方质量基线。

边界：支持有界字段契约/等值条件而非完整 JSON Schema 或语义技能评分；外部资源是固定内容快照，不是自动更新知识库。
离线历史快照不能得知远端新撤销，时效性依赖 expiresAt/Host 同步撤销。远程 HTTP、模板/动态参数、订阅/热更新仍未完成。
导出范围是单资源 manifest+正文，不是完整资源包签名归档/跨主机导入；不能宣称全部资源包迁移能力已完成。
本批当时保留的跨角色 lineage、取消信号与等待截止缺口由下述续批承接；任意文本污染追踪、语义压缩质量、任意远端清理保证及原生实机/真实模型验收缺口仍保留；应用与具体场景不解冻。

### 2026-08-31 续批：跨角色来源治理与有界压缩生命周期

本轮完成同一组合链的 Contract、生产接线、SQLite 持久化及回归，不增加应用或具体场景：

- 资源新增显式 `readerRoles`，默认仅 Worker；Planner/Observer 读取派生上下文也必须通过精确包、Scope、阶段、能力和生命周期检查，
  Worker 不借其他 Work 的权限。旧包元数据不能原位扩大授权。
- `RunContextPolicy` 以同 Run 的上下文回执为来源，为 Planner 新 Work、Observer 指令、Worker 决策保留快照/来源依赖。
  撤销、版本/内容变化、权限失效、缺缓存、退役会过滤受影响的摘要、任务/重试后代、指令和已知依赖图节点；审计原件不改写。
  这是保守结构化追踪，不保证识别任意复制文本；当前轮所有有效来源都计入派生依赖，并非模型语义级引用分析。
- 三角色模型发送前及结果应用前检查来源；在推理期间撤销资料，返回动作被拒绝，Worker 经显式续跑重新判断。
  来源指纹参与 Planner/Observer 唤醒，资源变化无需伴随 Run/Graph revision；含资源历史的旧快照不能原样重放。
- 通用 `ContextCompactionRuntime`、可替换压缩器和 SQLite `prepared/completed/failed` 生命周期已接到三角色实际输入。
  按预算缩短 summary/resultSummary/rationale，独立记录来源路径、输入输出及受保护结构指纹；目标、任务指令、ID、引用、审批与 Schema 不交给压缩器修改。
  默认只是带省略标记的首尾摘录，`semanticQualityVerified=false`，不替代原始证据或事件。
- 超时/错误引用/超预算结果回退安全范围内的原投影；原文也超限则拒绝发送。重启将未完成压缩标为失败，精确身份才可复用完成记录。
  相同失败身份不后台重试；新输入/来源/版本/预算才形成新尝试。输入硬限 1 MiB、输出 256 KiB、文本预算 16,000 字符、默认截止 1 秒。
- 压缩/Observer 新评估表各最多 4096 条，派生表 8192 条，均接物理空间准入且不删审计腾空间。
  单 Run 上下文来源 256、派生记录 512、Work/输出/指令各 512；满额拒绝，规模扩展仍未完成。
  保留本次供应的全部 Work/图节点身份及 Worker transcript；recentEvents 仍是调用者的有界窗口，不宣称已压缩全部历史事件。

回归涵盖默认角色隔离、继承任务权限不扩大、撤销/权限/元数据/退役、图依赖过滤、旧动作拒绝、独立来源变更唤醒、
压缩失败/超时/引用篡改/预算、持久化恢复，以及真实 HTTP Worker → Observer 长上下文 → 全新宿主撤销过滤。
模型均为确定性替身，未执行真实模型或多日长跑。详细边界见 `docs/architecture/context-and-mcp-assembly.md`。

验收状态：机制回归与构建结果见下节；任意文本污染分析、真实语义压缩质量、压缩事件的统一线协议、
长期归档/扩容、原生实机与完整签名资源包迁移仍是缺口；当时的统一取消缺口由下述续批承接。

### 2026-08-31 续批：统一取消与 Discovery/RPC 截止

已将 Run/Work 状态事件、Scope 撤销、Worker 执行权、模型与工具取消接成通用链，不修改应用或具体场景：

- Embedded Worker 同步核对当前 Run/Work/lease/worker；取消、暂停、授权撤销和身份变化会中断本地执行。
  另有默认 1 秒一次、单次 1 秒截止的 assignment 核对，租约过期/查询失败停止执行。没有新增后台自动续租。
- Worker 支持可中断的模型、目录和观察器等待，停止 Supervisor 会取消活跃执行；保存待执行检查点期间取消也不再派发。
  信号独立于模型数据，工具 RPC 序列化时移除。迟到决策不再进入执行控制流。
- Gateway 派发前检查信号，已进入执行阶段的取消/超时保留 uncertain，不保存迟到成功回执；暂停/取消状态与调用围栏跨宿主恢复，
  不能据此自动重派。复用现有模型排队取消、Provider 公平调度取消与进程工具终止请求。
- Discovery 默认 15 秒外部发现截止，超时排空该 generation、保存 degraded，不接受迟到目录；未结束调用仍计入在途数量。
  候选激活超时不排空旧活动版本；关闭/停用排空也有上限，未完成时明确报错，不删除归属来伪造成功。
- Execution Node RPC 默认 120 秒调用截止（含连接）、256 个在途上限及两倍单帧的写缓冲上限；超时忽略迟到响应、不重发。
  连接 generation 隔离旧连接回调，Provider 总请求截止额外覆盖握手/启动/发送/响应。
- Provider 取消期间迟到握手不能再启动；迟到启动拿到归属后请求清理，不能再发送工具命令。
  启动结果未知或清理失败保持 failed，普通 Provider 与 MCP 都不能假装 stopped 或直接 restart；清理等待有界。

新增回归覆盖真实 HTTP 取消/暂停/Scope 撤销、非协作工具与模型、未知调用跨宿主重启、Worker 身份/租约/查询超时、
检查点期间取消、真实 Provider 子进程终止、发现/启动/清理迟到与 Socket RPC 截止/容量。
过程中的测试夹具能力声明和类型错误已修正；完整回归另发现终止请求可能先返回 running，
现已补上有界终态观察，不能把终止请求返回直接当成清理完成。最终完整验证结果见质量基线。

边界：取消信号与 Host 截止不等于任意远端动作已停止，更不构成独立进程树清理或无副作用证明；
不协作适配器的占用/围栏可继续保留，须已有独立恢复证据。共享 Discovery 不随单个 Work 取消而整体中断，遵守自身截止。
自定义 statePort 持久化等待不在外部发现截止内；生产仍用 SQLite 事务。不新增统一清理证明签发器；后续占用批次已完成默认 Managed Provider 的跨重启配额重建，非全部执行来源。
真实模型、Windows 双模式、24/72 小时长跑继续暂缓。完整说明见 `docs/architecture/cancellation-and-deadlines.md`。

### 2026-08-31 审计事件协议与恢复读取批次

已接通共享协议、SQLite 事件流、实际 Foundation 宿主和恢复来源，应用与具体场景保持冻结：

- 统一 v2 decoder，新增默认 256 项窗口的顺序读取器；重复、乱序、冲突、缺口、未知版本与旧窗口之外的 stale 有明确行为。
  校验 Case/Run 归属、Turn 的 Work/role 身份、Turn 内 Item 类型及 SQLite 索引/JSON 一致性。
- 新增绑定 Case/Run/上一条 Event ID 的版本化 cursor 与只读 replay/reference GET；跨 Run、缺失/替换锚点及未来数字游标拒绝。
  页读取与水位在同一 SQLite 读事务内。保留旧数字 after 接口，不改变现有 UI；旧接口不能识别游标来自哪个 Run。
- durable 控制 revision、压缩缓存、实际输入快照中的压缩/回退 manifest、未知调用观察、恢复请求及独立对账分别补记，
  每个源事实的事件组与永久去重 key 原子提交。记录 completion 不表示外部工具/进程已清理；引用读取不触发模型、工具或恢复命令。
- 模型取消新增结构化 termination_kind，同一 finish 事务保留取消身份，重启不将新取消记录误记为普通失败。
  审批 terminal Item 已落盘但 Turn 缺失也能补齐；模型/审批补偿有界，Worker 快照补偿只接管启动前的快照，避免终止活跃动作。
- 外层事务回滚不会发送虚假事件；单个通知回调故障不影响其他订阅者。生产生命周期审计是可恢复的 best effort 投影，
  审计满额不能阻塞排队模型取消、名额释放或 Run 停止；模型/工具本身的持久化及执行围栏仍正常生效，不因审计故障获得新权限。
- 新事件限 200,000 条、JSON 总量 256 MiB、单条 128 KiB，另检查物理余量；旧记录不删改，满额拒绝新增审计记录。
  宿主启动/Run 变化/每秒有界补记并暴露 pending/delayed/上次扫描状态。不会删永久键腾空间，也没有把读取错误伪装成空列表。

边界：这是最终一致的事实投影，不是全部来源的强一致因果全序；轮询可能略过瞬时 prepared/uncertain 状态，
mutable 调用明确记录为观察，不能冒充完整执行历史。hasMore=false 不代表所有业务源已投影完毕。
cursor 不是授权凭据，管理读取的调用来源隔离、所有历史事件的冷热归档/扩容仍未完成；默认 Managed Provider 的未知清理占用已在后续批次接入重启恢复。
真实模型、Windows 双模式及 24/72 小时验收继续暂缓。设计与验收说明见 `docs/architecture/agent-audit-replay.md`。

### 2026-08-31 执行清理占用与重启配额批次

本轮已完成默认 Managed Provider 的组合交付：持久化占用账本、启动前同步派发屏障、本地名额与外部占用分离、
重启重建、旧调用保守迁移、独立证据授权释放、幂等原子审计、GC 保护与共享审计引用。没有修改应用或具体安全场景。

- 占用固定 Invocation/工具/输入/Case/Run/Work/owner/lease 与 request 身份，Provider 包版本不与工具版本混用。
  排队后重新核对 Worker lease；存储拒绝不派发，也不错误累积 Provider 隔离预算。
- 调度同时计算 active 与 retained，全局、Provider、工具、Run、Work 维度都计入未知外部占用；先保留、后释放本地名额。
  结算写入失败仍保留内存围栏；单宿主重启在准入前恢复旧占用。只有派发屏障未提交的 reserved 可凭未派发事实释放。
- 普通 close/Receipt 完成不能证明外部清理。独立证明须通过已有宿主授权/签名验证，并匹配 v2 持久化进程归属及精确结果。
  新清理命令只释放占用，不修改 Invocation 结果、不新建 Work/重试；已提交的有效对账可幂等复用。
- 新增占用查询、受控清理接口及 `executionOccupancy` 审计来源。未释放占用保护工具包与 scratch，即使原调用已 completed。
  释放审计与状态在同一事务提交；拒绝/过期/撤销/篡改/跨请求/非进程证明不释放；读取不触发执行。
- 旧 Manifest 精确映射的 executing/uncertain/completed 调用全部保守保留，映射歧义拒绝启动，不猜版本。
  永久占用键上限 100,000、清理审计 50,000，单 identity/审计 8 KiB，并检查物理余量；满额拒绝、不删账恢复。

该历史批次边界：覆盖默认 Managed Provider factory；后续统一占用批次补入内置进程与 MCP，再后续自定义来源批次补入显式宿主端口契约。一条占用不代表精确 OS 资源数量。
依赖单活宿主管理 SQLite，不宣称多节点配额。没有可信独立清理证明时，即使正常结束也继续占名额，可能阻止后续调用。
没有新增原生可信报告签发器；缺失进程记录或旧 Manifest 无法精确映射时不能声称完成恢复。
本批新增 31 项回归（含三个 SIGKILL 断点与两次磁盘恢复）及既有迟到启动断言扩展；最终完整门禁结果见第 6 节。
设计和接口边界见 `docs/architecture/execution-capacity.md`。

### 2026-08-31 受控上下文资源包签名迁移批次

本轮完成完整上下文资源集合的签名导出、独立授权导入、事务化发布、当前信任检查、命令审计和生产 HTTP 接线。
包含 Skill 正文/输入输出契约、知识正文、引用/冲突/角色/能力/有效期及外部 MCP Resources/Prompts 声明；没有改应用和具体场景。

- `traceforge.context-package.v1` 使用 Ed25519，固定 Package 版本、位置无关清单摘要、资源内容摘要、完整排序清单与签发身份。
  目标宿主必须已有匹配的审核契约；包内缺项、重复、契约/版本冲突和额外路径字段拒绝。清单含非 context 资产则整体拒绝，不静默部分导出。
- 外部 MCP 只迁移资源声明与已审核 profile 摘要，不带缓存正文、可执行配置、凭据或授权；依赖缺失拒绝，导入不启动进程、不联网、不注册新 Scenario。
  本地 locator 不上归档。资料正文/声明参数中的敏感内容仍须由导出授权者审核，未实现自动秘密扫描。
- 生产新增 `/api/scenarios/context-packages/transfer`，export/import/inspect 均需宿主注入授权，签名/信任默认未配置。
  管理动作不暴露为模型工具；审计引用解析只读最小元数据，不续跑。导入固定版本不改变旧 Run 或授权策略。
- 采用最多 1 MiB 的内存隔离接收和一次 SQLite 事务：正文、签名原件、导入绑定、成功审计一起提交；失败或强杀没有可用半包。
  同命令同输入幂等，不同输入冲突；重放仍重新授权、验当前信任和正文，不能复活退役/撤销资料。
- 导入后读取、检索/上下文投影继续核对签名者当前有效期与撤销状态；没有验证器就拒绝读取，重启不退回未验证的本地安装。
  已落回执的资料失去信任后也从下一次模型输入中移除，原始审计回执保留。Scope/角色/资源有效期与 MCP 配置仍独立生效。
- 归档最多 128 个、合计 16 MiB，审计最多 2048 条；单正文 64 KiB，另受现有上下文库上限和物理空间门禁约束。
  签名原件、导入绑定和命令审计永久保留，满额不删账；资源退役不会删掉签名原件中的审计正文。

本轮新增 37 项测试：完整迁移、错误清单/签名/依赖/授权拒绝、授权期间请求不可变、当前信任、HTTP Worker 读取与撤销过滤、并发重放、
磁盘压力和提交失败，以及三个 SIGKILL 窗口后两次数据库恢复。模型均为确定性夹具，不是真实模型验收。
明确未覆盖：混合资产/可执行 Scenario 安装、跨版本 Run 迁移、签名轮换重新背书、撤销配置自动分发、原件归档扩容和大包性能验收。
不同签名 Envelope 即使正文相同，也不能覆盖同 Package 版本的既有导入绑定；须新版本或后续受控重新背书流程。
设计与接口见 `docs/architecture/context-package-transfer.md`。

### 2026-08-31 内置进程与 MCP 统一占用治理批次

本轮完成生产接线、逐进程派发账本、共享配额、独立清理证明、重启查漏、查询/审计与故障回归；未改应用和具体安全场景。

- 底座创建一个公平调度器，默认 Managed Provider、内置进程、MCP Tools 发现/调用、MCP Resources/Prompts 读取共同计入 global/来源版本/操作/Run/Work 上限。
  Managed 保留原 Invocation 账本；新增逐进程账本，不把一个父调用的多个 MCP 进程合并成一条已清理资源。
- Work 入口在排队和派发屏障核对当前 Worker lease/Invocation，保留原 Scope/审批/profile/schema 检查。
  MCP 发现使用明确配置的宿主服务归属，不伪造 Work 或 Invocation；来源关闭可取消排队中的发现。
- 未派发 reservation 可释放；已派发普通退出只记 terminal_observed，未确认清理继续占名额。
  结算失败仍保留内存围栏，重启重建已派发占用；有 journal、无可映射来源的旧进程以 legacy.unattributed 查漏，不猜工具来源，也不重复计入已有账本。
- `traceforge.process-cleanup.v1` 要求独立宿主授权、Ed25519、当前受信来源/节点、精确持久化 v2 launch/request/归属和有效期。
  证明只释放名额，不证明动作无副作用，不改结果或重试任务。请求先固定副本，成功审计与释放原子提交，重放幂等且重新授权。
- 新增有界分页/单条占用查询、清理接口、接线覆盖诊断；共享 `processOccupancy` 审计只投影真实 Work，服务发现不伪装成 Run 事件。
  默认上限保持 global16/perProvider8/perTool4/perRun4/perWork1；受控宿主可配置，HTTP 不提供强制清空。
- 新表永久占用键 100,000、清理命令 50,000；identity 8 KiB、证明 64 KiB、审计 8 KiB，有物理余量门禁；满额不删账。

本批新增 44 项测试（42 项进程账本/证明/故障回归、2 项 MCP 竞争/关闭回归），扩展既有 MCP Tools/Resources/Prompts 的生产占用断言；
包含三个 SIGKILL 窗口和两次重开恢复。测试使用中性协议夹具与测试签名，不是原生可信清理或真实模型验收。最终门禁见第 6 节。
明确限制：普通完成也可能持续占名额，MCP 重启发现可因旧服务名额耗尽而被挡住；需独立清理证明，不能伪造新身份或删除账本绕过。
该批当时不拦截自定义 factory/source 和 Scenario 原始 executionNode；后续自定义来源批次已收紧宿主装配与端口，见下文。缺失持久化进程历史仍无法还原全部旧执行。
单宿主 SQLite、多节点配额未实现；自动可信签发器、永久键扩容/控制历史归档仍未完成。
设计与接口见 `docs/architecture/process-capacity.md`。

### 2026-08-31 执行治理历史分层归档与恢复核验批次

本轮完成两类已核实清理历史的生产归档、透明回读、重启核验、诊断和故障回归；未改应用和具体安全场景。

- Managed cleanup audit + 签名 Recovery Evidence，以及逐进程 cleanup 签名原件 + audit 可在独立宿主授权后压缩到既有执行冷库。
  占用身份、state/requestId/proofRef 与永久 command fingerprint 留在热库；未知/活动占用不归档、不释放。
- 新增永久 `execution_governance_history` 索引，固定 cleanup command、occupancy、Case/Run/Work、结论、时间和 proofRef。
  MCP discovery 使用真实服务归属即可归档，不要求伪造 Scenario Run、Work 或 Invocation。
- 归档重新核对 released 状态、释放依据、逐进程 proof hash/identity，或 Managed Evidence 的 Invocation/ownership。
  没有保存签名 Envelope 的自定义 Managed 证明不能只凭字符串引用归档。搬运不是新授权，旧证明不会获得执行权限。
- 请求在授权前固定副本，授权有 10 秒截止并在提交前复核有效期；最多 32 条/16 MiB。
  Evidence、cleanup body、热表 marker 与命令审计同事务提交；中断/容量/磁盘拒绝整批回滚，同命令重放重新授权并保持幂等。
- 原 cleanup replay 透明读取冷档并核对长度、摘要、Envelope、热表投影、永久索引、占用和关联 Evidence。
  启动前验证冷数据；缺失/损坏/marker 不匹配 fail closed，不误释放名额、不改变结果、不自动重试。
- 新增候选分页、单条元数据诊断和受控归档 HTTP；不返回签名/证明正文/actor/reason。
  使用既有 1 GiB/200,000 条冷库与物理 recovery floor；归档回收逻辑热正文预算，但不删除永久键、不保证数据库文件立即变小。

本批新增 47 项回归，覆盖两类历史各三个 SIGKILL 窗口后两次恢复、冷写/热替换/命令提交回滚、冷数据缺失/篡改、
关联 Evidence、授权快照/截止/提交前过期、并发重放、Scope/保留期/分页、逻辑/物理容量和生产 HTTP 零模型调用。
夹具签名和 Execution Node 为确定性测试机制，不是原生平台、真实模型或多日长稳验收。设计见 `docs/architecture/governance-history-archive.md`。

仍未实现：永久 key 分区/扩容、独立对象冷库、多节点一致性、归档 key rotation、全部事件/上下文历史归档。自定义来源的宿主入口治理见下一批，不能等同任意 JS 全面拦截。

### 2026-08-31 自定义执行来源统一治理与装配门禁批次

本轮整批完成契约、生产接线、共享调度、生命周期、兼容迁移、诊断和 58 项新增集成回归；未开发应用/具体安全场景，也未引入账号或租户。

- `worker-runtime` 提供 source/version/process 模式、显式服务发现归属和 `GovernedExecutionPort` 契约。
  来源工厂及工具身份/版本不匹配、无效模式/截止、process-denied 却声明进程能力、无节点的 governed 来源拒绝。
- 生产组合根新增 `governedToolSources`、`governedToolProviderFactory` 和 `scenarioSourceExecutionPolicies`。
  旧自定义 source/factory 默认拒绝；测试/迁移必须显式启用 `allowUnmanagedDevelopmentSources`，诊断标记为未治理。
  新 Provider 工厂收到安装信息副本，返回来源/版本固定到已核验安装身份，不能改写比较依据。
- Scenario 新增 `context.execution`；兼容 `executionNode` 不再提供裸节点，仅保留带当前调用归属核对的 brokered HTTP。
  未声明的旧 Scenario 来源默认禁止进程，不冒充完全无外部副作用；新进程工具必须声明并走受控端口。
- 宿主私有异步作用域固定 source/version/operation、Work/父 Invocation 和权限快照。
  自定义进程使用独立子 key、现有逐进程派发屏障与共享配额；服务发现要求真实宿主 attribution 和同步授权，不制造 Work/Invocation。
  在排队与派发点复核身份/授权；误写成 async 的服务授权会拒绝，而非默认允许。
- 调用取消、源关闭、租约/操作截止统一传递，晚到 start 仍请求清理；结束后的回调和跨来源端口调用拒绝。
  每个操作最多 64 个挂起宿主请求，不 await 已提交操作也不能提前回传成功。纯内存/HTTP 不制造进程占用。
  正常退出仍仅是 terminal_observed，未知清理和重启保留占用；不改父 Invocation 结果、不自动重试。
- 覆盖诊断列出自定义/声明 Scenario/旧 Scenario 限制模式及开发逃生开关；这是装配声明，不是实时健康或 OS 隔离证明。

实际边界修正：**宿主端口治理不等于任意 JavaScript 沙箱**。同进程工厂仍是需审核的可信宿主代码，
不能检测或阻止它自行 import child_process、或使用事先保存的外部裸节点；不可信执行包应走进程外受控 Provider/MCP 与已验收沙箱。
HTTP 已发出的请求没有独立取消协议，只限制超时并拒绝迟到结果，不承诺撤销副作用。
后台/交互式进程句柄、跨调用 adopt、多活宿主和原生可信清理仍不在本批交付范围。
回归使用协议节点/测试归属，另有实际 HTTP Worker 的无进程自定义来源端到端测试，不冒充真实平台或真实模型验收。
架构与迁移说明见 `docs/architecture/governed-execution-sources.md`。

### 2026-09-01 单用户宿主管理与 Worker 通道隔离批次

本批完整交付默认通道门禁、生产组合根/嵌入 Worker 接线、生命周期、迁移说明、诊断及新增 66 项回归。
只改宿主装配和通用底座；未开发 UI、具体安全场景、账号、登录、租户或用户管理。

- `FoundationHostControl` 只通过可信宿主进程内 API 发放独立管理与 Worker 通道，随机 256 位票据仅驻内存。
  API/事件流默认归管理通道，健康检查保留；生产 `main` 调整注册顺序，让旧配置/Case 等应用 API 也经过门禁。
- Worker 通道固定宿主提供的 Worker 描述符、能力集合和定义版本，只允许注册、自己的心跳/任务列表及六种已有 Work 控制操作。
  Work 命令核对当前 Run 状态、Work/workerId/leaseId 和未过期租约；不能审批、恢复任务、释放未知占用或修改 Provider。
- actor、Origin、cookie、query、正文中的身份不作为凭据；重复/合并 Authorization 拒绝，不保留匿名兼容逃生开关。
  请求进入、正文解析后与路由钩子结束/处理器执行前复核通道和所有权，等待期间撤销/到期/任务取消不能继续进入处理器。
- 默认一小时票据期限，只有可信宿主持有的通道可换票；复制的旧票不能续期。
  缩容/停止/Worker 替换与启动失败撤销通道，宿主关闭/重启不恢复旧票。
  活动票据最多 1,024，管理票据最多 8，Worker 绑定数量也有上限；诊断不暴露凭据。
- 受保护入口只接受真实 socket loopback 来源，忽略转发身份头；受控 fetch 限制本机 app origin，禁止跨站和重定向转发凭据。
  原 Scope/审批/签名清理证明校验保留，管理通道本身不等于业务授权或清理证明。
- 真实 HTTP Worker/模型/Provider/检查点/取消恢复链迁移到受控传输；模型和工具上下文不获得管理/Worker 通道凭据。
  新增真实运行工具试图用 task 身份暂停 Run 的越界回归；请求被拒绝，正常任务仍可执行。

兼容与验收限制：旧匿名 API 客户端会收到 401，Worker 越界请求收到 403；前端/桌面 UI 受信桥接尚未适配，继续冻结。
健康/静态页可打开不等于旧 UI 已能操作底座。嵌入方必须先装配 Foundation 门禁再注册其他 API，并通过宿主 API 获取通道。
没有 HTTP 领票端点、磁盘凭据或日志分发；远程管理/反向代理信任不在本批支持范围。
可信同进程 JS、任意系统权限和已经进入业务处理器的副作用仍不由通道票据隔离或撤销；需要独立沙箱/业务围栏。
设计、迁移入口和上限见 `docs/architecture/foundation-host-channels.md`。

### 2026-09-01 场景包版本迁移与旧 Run 保留状态恢复批次

本批交付 SDK 兼容契约、Core 迁移事件、受保护宿主管理入口、资源/授权预检、原子审计和中断恢复；不开发应用或具体安全场景。

- 只支持 `preserve_state`：同一包 ID，包版本不同、schemaRevision/Definition.version 前进，Definition 除版本外相同，输出 Schema 标识相同。
  新旧包共享经过审核的授权策略与工具工厂函数；目标 Schema 重验历史输出。不同 JS 实现不靠名字或摘要猜测语义兼容。
- 迁移须有精确版本对的显式 manifest/body、当前包信任和有效 scope；默认缺少信任验证器/独立迁移授权时拒绝。
  本地上下文与迁移资源核验内容/生命周期；外部资源或其他可执行/二进制资产没有专用验证器时拒绝。
- 仅暂停 Run 可迁移；活动租约、开放调用、待批记录、未知进程/Managed 占用均阻断。已结束 Work 的历史租约编号保留，不混同活动租约。
  检查点必须是完整且无待处理调用的精确 v2 文档；证据引用、输出、审批、预算和旧事件不改写，不自动恢复、不重做副作用。
- 请求快照、预检指纹、授权后复检和事务内围栏组成提交检查；事件、绑定/定义投影、不可变审计同事务提交。
  同命令重复提交重新授权后返回原审计，并发只产生一次迁移；共享审计流支持补记，失败不留下半改绑定。
- 迁移后的 Run 可仅依赖目标包回放；继续执行仍须显式恢复和领取新租约。初次迁移及迁移命令授权重放仍需要源/目标包当前可用且受信。
- 新增 48 项集成回归：包含历史审批/输出/证据引用/检查点保留、资源撤销/异步竞态、默认拒绝/生产管理入口、
  三个真实 SIGKILL 窗口和各两次新宿主回读；Core/SDK 定向合计 71 项通过，完整基线见下节。

边界：不是任意安装器/JS 迁移脚本，未实现自动排空、多跳/降级、结构转换、混合资产校验、迁移历史归档或永久键扩容。
审计最多 50,000 条、资源最多 1,024 条/8 MiB，达到逻辑或物理限制时拒绝新增；不代表永久可持续写入。
当时核对源码发现 scope 授权服务仍按 scenario kind 选择最新包策略，迁移入口曾要求最新策略与源策略实现一致。
这一限制已由下面的固定授权批次替换：从固定策略读取，并把绑定修订纳入迁移指纹。设计及入口见 [Run 版本迁移说明](architecture/scenario-run-migration.md)。

### 2026-09-01 授权策略版本固定与升级兼容批次

本批整合授权持久化、Run/Worker/工具生产接线、显式历史恢复/兼容升级、并发/回滚/重启回归；不建设账号系统，也不开发应用或具体安全场景。

- 新授权与精确 Package 绑定同事务创建，记录修订号、Definition 契约和 scope 原文摘要。新建可指定 Definition 版本；读回不再追随最新安装包。
  Action/Resource 授权统一走固定包，包缺失、正文/契约变化或历史未绑定均明确拒绝和诊断，不猜测旧版本。
- Run 启动、调度、续租和恢复核对授权兼容；上下文资料、MCP Tools 与 Run 迁移复用同一解释入口。
  Embedded Worker 的通用 Gateway 在目录选择、审批等待后及实际派发前复检 scope/Work 所有权，覆盖正常宿主装配的内置、场景和自定义工具。
  Provider Capability 与 Execution Node 原有资源授权端口也读取固定包。旧回执回读不是新执行，仍保留可追溯事实。
- 历史未绑定授权不自动修补；提供默认拒绝、独立授权且受宿主管理通道保护的 preview/upgrade/audit 入口。
  允许明确确认旧 scope 的策略版本，或升级至共享授权实现、解析 Envelope 一致的前向版本。改权限语义须新建授权，不覆盖原审批。
- 升级前所有关联未终结 Run 必须暂停，无活动租约、待批、开放调用及未知执行占用。scope 原文、有效期、Run 事件和检查点不变，不自动恢复任务。
  请求固定、授权后复检、绑定修订与不可变审计原子提交；并发/重复命令不重复升级，错误和强杀不留下半成品。
- 36 项新集成回归和 2 项 Gateway 派发复检回归覆盖多版本放宽/收紧、缺包、旧数据显式确认、Run 与 scope 双升级、
  当前信任/授权竞态、真实 HTTP/模型替身后变更、物理拒绝以及三个 SIGKILL 窗口各两次新宿主恢复。完整基线见下节。

边界：固定授权包身份不等于包可执行代码/依赖验签；当前 Definition 摘要与函数引用不能证明闭包未变化。
Run 仅事件回放可以只装目标包；若 scope 仍固定旧包，授权执行仍需旧包，须再明确升级 scope 才能移除旧依赖。
未实现语义变化授权的旧 Run 改绑、自动排空、任意可执行包安装、升级历史归档/分区。绑定和审计各最多 50,000 条，满额拒绝新增。
设计与恢复入口见 [授权固定与升级说明](architecture/pinned-scope-authorization.md)。当时安排的包受信装配批次已由下节承接，不改做 UI。

### 2026-09-01 场景包审核材料与不可变受信装配批次

本批完成 **签名材料契约 + 不可变版本登记 + 生产当前使用门禁 + 独立撤销审计 + 故障与强杀恢复回归**，不增加具体安全场景或应用 UI。

- 清单固定精确包绑定、入口与依赖/数据的路径、大小和 SHA-256；Ed25519 审核绑定材料、声明契约、宿主装配引用、公钥身份及有效期。
  不根据路径加载 JS；已加载对象与文件的关系须可信宿主同步确认。声明和工厂/策略/输出函数引用也在使用时复检，不把函数文本或版本号冒充代码证明。
- 同 id/version 材料及契约首次登记后不可替换；相同材料可合法重新审核，登记和审核历史事务提交。
  文件缺失、替换、链接、签名/期限错误、当前公钥失信或撤销均隔离；开发显式放行不能绕过已有审核或坏签名。
- 受检 Registry 接入 Foundation、提前创建的 Execution Node 授权、固定 scope、Run 恢复、策略升级、Run 迁移及上下文目录。
  未审核包不调用工具工厂，旧来源 discovery 前后和已发现工具执行前重新检查当前信任；其他可用包不因隔离目录整体失效。
- 受保护管理通道提供状态、撤销和不可变审计回读；撤销必须独立授权，10 秒等待截止、请求快照、提交前有效期复检、幂等/冲突与物理容量限制共同生效。
  撤销不抹掉旧事件、审批、证据和检查点，不自动恢复任务或释放未知外部占用；重启和重新签发同一材料不能解除持久化撤销。
- 新增 40 项中性集成回归，包括生产管理路由、旧工具目录阻断、材料恢复、不可变同版本、数据库回滚和物理拒绝。
  登记事务内、撤销事务内、撤销提交后三个窗口真实 SIGKILL，各两次新宿主回读；完整验证基线见下节。

部署影响：生产默认无审核材料即隔离；现有 main 的 Web 包也不会被自动背书，健康检查、元数据和管理诊断保留。
受信宿主必须显式提供审核材料、公钥策略及装配关联；当前应用未接发行配置或受信 UI 桥接，测试夹具才显式采用开发模式。
不宣称文件验签能证明任意内存实现/闭包、清单外动态依赖或隔离同进程系统调用；逐文件复检也不是原子文件系统快照。
被撤销包会挡住正常 Run 加载/命令；当时安排的无包依赖取证、停止和退役检查由下节承接，不把“有错误诊断”算成完整运维恢复。
单包最多 128 文件/4 MiB，遍历最多 256 项/16 层；材料/审核/撤销历史分别最多 256/1,024/10,000 条，满额拒绝，不删账恢复。
每次使用同步复检存在性能成本，规模验收、历史扩容、原子安装和自动代码来源证明未完成。详见 [受信装配说明](architecture/scenario-package-trust.md)。

### 2026-09-01 失信包下旧 Run 取证、停止与退役处置批次

本批完成 **无包依赖事实读取 + 独立停止/退役授权 + 当前执行收尾核对 + 生产取消通知 + 原子审计与重启回归**，不增加应用 UI 或具体安全场景。

- 通用事件归约读取核对 Run/Case、序号、修订、包绑定与状态投影，不调用旧包 Definition/策略/输出解码/工厂或模型。
  提供受保护的状态、事件 keyset 分页，以及检查点/审批/调用/进程/Managed 身份与引用分页；取证状态明确不授予执行权。
- 新的 stop 操作不依赖包或原 scope 重新获得信任；须可信宿主独立授权，默认拒绝。
  取消事件和审计原子提交，复用通用 Work/租约/待批/准备中绑定投影，保留原证据、输出、审批历史与检查点正文。
- 提交后通知 Worker 与 Model Runtime。Worker 所有权核对、取消审计发布改用通用事实，失信包不再挡住取消通知；模型在途和排队请求复用原取消链路。
  普通 Runtime 同时补上当前/目标状态的提交前包信任检查，避免先写入命令再在返回加载时拒绝；不允许用取证入口恢复或派发任务。
- retire 必须在已结束 Run 上重新核对租约、待批、prepared/执行中/未知调用、未释放进程/Managed 占用，以及在途模型和排队准入。
  仅当无当前待处理项才写一次退役回执；不删除历史、不释放配额、不签发清理证明。迟到异常显示 `retired_unresolved`，不会被旧回执隐藏。
- 请求快照、独立授权、10 秒等待截止、提交前状态/修订复检和幂等冲突共同生效；同命令重放仍重新授权，管理/Worker 通道隔离保持不变。
  新增 39 项集成回归，包括真实 HTTP 在途工具被撤销后停止、迟到结果不提交、无包重启保留未知结果、历史审批/检查点/证据引用、物理拒绝和读取/写入上限。
  停止事件内、停止审计内、停止提交后、退役审计内和退役提交后五个窗口真实 SIGKILL，各两次新宿主回读。

停止不是外部动作已经结束：未知结果须继续通过既有对账/可信清理流程核实，不能靠删除租约宣称进程已释放。
当时完整处置回放限 5,000 事件/16 MiB 原事件/2 MiB 状态；后续下节已改为快照加有界尾部。分页最多 100 条/事件正文 4 MiB，stop 最多更新合计 1,024 条执行权投影。
超限或完整性异常整体拒绝，原事件仍可分页查看；超大单事件、超大状态和任意长度历史的处置仍有限制。审计最多 50,000 条/单条 8 KiB，满额拒绝不删账。
详情见 [无包依赖 Run 处置说明](architecture/scenario-run-disposal.md)。当时的长历史优先级由下节承接；当前百分比不因新增接口或测试数量上调。

### 2026-09-01 Run 长历史快照与冷热归档恢复批次

本批完成 **精确状态快照 + 原事件压缩/透明回读 + 幂等与租约历史保留 + 受控归档/物理准入 + 生产接线与强杀回归**，不增加具体场景或应用 UI。

- 每段保存连续前缀的原始事件行、末尾 revision 的纯事件归约状态、格式/归约器版本、包绑定、原件/压缩字节/快照/起始事件摘要及段链关系。
  事件序号、命令指纹、输出/证据/审批/检查点引用不删除；原表只替换旧正文为冷引用，起始事件保留热副本供原授权索引查询。
- Core 增加可选状态读取、历史租约查询和状态容量校验端口，不引入 SQLite 或压缩依赖。
  生产 Runtime 从快照接有界尾部，继续检查当前包信任；新状态超过 2 MiB 时在提交前拒绝，处置取消同样复检大小。
- 当前读取核对序号、段链、压缩字节、热引用覆盖、旧租约索引、选定快照和 Run 投影；缺段/损坏/绑定错误不回退为猜测状态。
  新 claim 与永久租约索引原子写入，旧 claim 在归档事务补入，旧租约不能因正文归档而复用。命令跨冷热段仍按原 event index 幂等回读。
- 受保护管理入口提供 metadata/preview/archive/audit，可信宿主独立授权且默认拒绝；请求固定、授权截止、revision/范围/源指纹复检、重复命令重授权和冲突拒绝共同生效。
  段、状态快照、热引用、旧租约索引、容量计数和审计同事务提交，归档不改变 Run revision/生命周期、scope 或执行占用。
- 正常 Runtime、无包依赖取证/停止、历史 revision 回放、固定授权升级、维护/旧执行归档检查、Planner/Observer 近期事件、控制事件发布与共享审计补记均接入新读取链。
  新增 41 项回归覆盖超过 5,000 条事件的历史、精确原状态、冷热命令/旧租约、包迁移/当前信任、资料/审计、生产无包重启和容量/竞态/缺损。
  段写入、热引用替换、审计写入和提交后四个窗口真实 SIGKILL，各两次新宿主回读。

部署边界：归档是同库压缩，不是数据库备份；不自动在启动时归档或发放权限，长任务宿主须明确配置归档授权并按需推进前缀。
每段最多 1,000 事件/16 MiB 原件，单 Run 最多 1,024 段；默认全库 1 GiB/100,000 段，审计 50,000 条/单项 8 KiB，超限拒绝不删账。
尾部回放仍限 5,000 事件/16 MiB、状态 2 MiB；每次使用仍扫描永久索引并校验压缩段字节，节省反序列化/归约成本，不宣称恒定恢复时间或无限容量。
独立冷库、永久键扩容、任意超大状态和真实长稳性能未完成。数据库灾难恢复已由只读取证恢复批次补齐，但不等于异地介质、密钥恢复或重新执行授权。详见 [Run 事件历史说明](architecture/scenario-event-history.md)和[底座备份与灾难恢复](architecture/foundation-backup-and-disaster-recovery.md)。

## 6. 当前质量基线

- 2026-09-04 Browser 真实集成/整树发行身份批次：macOS arm64 的 Chrome 152 真实跑通 pipe、navigation、302 redirect、popup、同进程 iframe、fetch/XHR、Artifact-backed download、DOM/截图/动作、人工接管恢复、renderer crash 通知，以及可复现单文件 Controller 的严格 manifest/stdio/正常退出链；页面全部由内存 Broker 注入，未访问外部目标。真实浏览器揭示并修复同进程 iframe 被误判普通 document、正常 shutdown 未销毁 stdin 导致 Controller 悬挂两项缺陷。发布清单升级为 v2，Controller 和浏览器启动文件之外还绑定完整安装树的文件内容、权限、目录与根内相对软链接；原子装配只写全新目标，复制前后摘要不一致即拒绝。Browser 短回归 12 文件/52 项、真实集成 1 文件/2 项、71,629 字节 bundle 可复现检查、16 packages/Server 编译和 304 个生产源码边界检查通过。开发机 Chrome 不是正式可再分发材料，本次真实运行不具备 Linux/Windows 原生 `network=deny` 证明，也没有运行真实模型、超长全量或 Linux 真机测试；生产 Browser 继续关闭，不接应用或 Scenario。
- 2026-09-04 Browser 页面交互/人工接管批次：新增有界 Accessibility Tree DOM Artifact、视口 PNG Screenshot、DOM 差异摘要、`generation/page/document/backendNodeId` 元素引用和 navigation/click/editable-only fill/固定键动作；Controller 只接受最近 DOM 观察实际签发的元素，Host 二次核对 base64、长度、SHA-256、MIME、严格 DOM schema 和代次后才写 Artifact。人工接管使用独立 takeover ID 与 manual observe/act 通道，网络仍经相同 Broker；接管/恢复双换代，Agent/人工旧引用全部失效，Snapshot 有界记录 Artifact、动作来源/输入摘要和控制权转换。新增严格 CLI/stdio 入口，Controller 可确定性打成 64,196 字节的单文件 Node 22 ESM bundle，构建检查禁止残留相对/workspace 运行依赖。Browser 短回归 10 文件/48 项、可复现 bundle 检查、16 packages/Server 编译和 302 个生产源码边界检查通过。本批没有运行真实 Chromium、原生平台联网、真实模型、超长全量或 Linux 真机测试，也没有修改应用或 Scenario；生产 Browser 继续关闭。
- 2026-09-04 Chromium pipe/发布身份批次：新增真实 `--remote-debugging-pipe` FD 3/4 transport，完成 NUL 分帧、单消息/总缓冲/在途命令/启动/命令/退出上限、失联强杀、stderr 原文扣留、固定安全参数与环境白名单，以及 Chromium 文件 SHA-256 和 `Browser.getVersion` 双核对；`--no-sandbox`、调试端口、代理、替换 profile 和未知环境均在启动前拒绝。严格发布清单同时绑定 Controller/Browser 文件名、版本、摘要、平台与架构，bootstrap 复核两个安装文件后只能走 pipe → CDP Adapter → Controller Process Runtime 的正式链。Browser 全链短回归 8 文件/37 项通过；Foundation 的 16 packages、Server 编译和 299 个生产源码边界检查通过。本批没有构建真实 Controller bundle/Chromium 发行物，也没有运行真实浏览器、原生平台联网、真实模型、超长全量或 Linux 真机测试；生产 Browser 继续关闭。
- 2026-09-04 Browser Controller 进程/CDP 策略批次：新增进程侧版本化帧 Runtime 与 Chromium CDP Adapter，完成 handshake/activate/request-result/shutdown 闭环、Target auto-attach、`waitForDebuggerOnStart`、新 page/popup/iframe/worker 的 request-stage Fetch 拦截、Service Worker 释放前关闭、未知 target detach、全局磁盘下载 deny、POST 原始 base64 entries 保留、Host Broker 响应注入、拒绝 `BlockedByClient`、Artifact-backed 下载核对及错误/超时退出。Browser 全链短回归 5 文件/27 项通过；Foundation 的 16 packages、Server 编译和 296 个生产源码边界检查通过。本批没有运行真实 Chromium pipe、原生平台联网、真实模型、超长全量或 Linux 真机测试。
- 2026-09-04 Brokered Browser Runtime Core/Host Controller 批次：新增 `@traceforge/browser-runtime`，完成 Browser Process OS 断网启动、pipe Controller 证明后激活、navigation/redirect/popup/iframe/fetch/XHR/download 逐请求所有权复检与授权、Execution Node HTTP Broker/Network Receipt、WebSocket 阻断、下载 Artifact、稳定 replay/未知结果围栏、租约/预算冻结、有界快照和失败清理。随后补齐 Host 侧 Execution Node Controller 的版本化长度帧、审核 Controller/Browser 版本与 SHA-256 对照、handshake-before-activation、稳定写操作 ID、并发/帧/缓冲上限、事件丢失/输出截断/资源超限/进程退出冻结及旧 generation 迟到响应隔离。Browser Core、Controller 与既有 HTTP Broker 联合短回归 3 文件/18 项通过；Foundation 的 16 packages、Server 编译和 294 个生产源码边界检查通过。本批没有沙箱内 Chromium/CDP 适配器、真实浏览器/原生平台联网测试、应用或 Scenario 接线，也没有运行真实模型、超长全量测试或 Linux 真机测试。
- 2026-09-04 Structured Worker Model 下沉批次：Worker 提示词、结构化决策、上下文裁剪/压缩、认知快照、模型路由、取消检查、排队后授权复检和决策来源记录已迁入 `@traceforge/cognitive-runtime`；Server 原 146 行实现文件删除，Embedded Worker 直接消费 package。WorkerHost 的租约、工具副作用、Checkpoint 和结果提交没有移动。三类认知角色、协作快照、跨角色血缘、Structured/Embedded Worker、Compaction 与 Evaluation 联合短回归 9 文件/48 项通过；Foundation 的 15 packages、Server 编译和 292 个生产源码边界检查通过。本批未运行真实模型、超长全量测试或 Linux 真机测试。
- 2026-09-03 Planner/Observer Runtime 下沉批次：`StructuredRunPlannerModel`、`StructuredRunObserverModel` 及两个 Supervisor 已迁入 `@traceforge/cognitive-runtime`；Server Adapter 分别由 470/392 行降至 83/94 行，只保留 SQLite Store/事务与 Fastify 查询路由。新增无 Server 的 2 项模型端口/决策合同测试通过；既有 Planner、Observer、协作快照和跨角色血缘 4 文件/26 项集成测试通过，合计 5 文件/28 项；Foundation 的 15 packages、Server 编译与 292 个生产源码边界检查通过。边界门禁禁止模型提示词、循环调度或 Supervisor 类回到 Server Adapter，并禁止 package 依赖 Fastify/SQLite。本批未运行真实模型、超长全量测试或 Linux 真机测试。
- 2026-09-03 Runtime/场景构建整改第一批：Web Scenario 的运行源码已拆成 6 个 TypeScript 模块，独立构建会在临时目录二次编译并逐字节核对产物、入口依赖闭包及模块集合；离线 Ed25519 打包已确认 6 个运行模块全部进入同一签名材料清单。上下文血缘纯投影与 Planner/Observer 共用装配已迁入 `@traceforge/cognitive-runtime`，Server 私有装配文件删除，SQLite receipt/snapshot/resource 读取仍作为 Adapter 留在 Server。4 个针对性文件共 24 项跨进程/装配/血缘测试在允许本机 socket 的环境全部通过，Web Scenario 与 Cognitive/Server 编译、290 源码边界和 15 packages Foundation 构建通过。本批没有运行真实模型、超长全量测试或 Linux 真机测试，也不据此宣称 Planner/Observer 已全部下沉。
- 2026-09-03 Linux Desktop 部署仓库批次：`verify:linux-deployment-assets` 通过，确认 DEB-only、脚本语法/权限、固定 helper/manifest、AppArmor 生命周期、systemd user-scope delegation、controller 与升级回滚接线；Linux 发布校验已增加真实 DEB control archive、`postinst/postrm` 和部署资产检查，待真机构建时执行；`local-execution-node-lifecycle` 4 项通过，Server 与 Desktop TypeScript 编译通过。当前 macOS 不能执行 DEB 安装、真实 cgroup/AppArmor、startup recovery/native probe 或协议 2/19 类矩阵，因此这些仍明确记为待 Linux x64 真机验收。
- 2026-09-02 本机 Execution Node 发布/健康/关闭生命周期批次后，全工作区 19 个项目构建通过。
- `verify:foundation` 检查 290 个通用生产源码文件，15 个通用 packages 与通用 Server 独立编译通过；门禁内共 113 个测试文件、1,600 项测试调用通过：主门禁 90/1,449（206.07 秒），本机 Execution Node/Linux helper 发布、生命周期、长期逐操作账本、统一扩展装配与崩溃终验 8/61（8.69 秒），Agent/Deployment/Artifact/State/Scenario Process/数据包加载及 Session 安全终验 15/90（9.31 秒）。Execution Node 故障文件固定串行执行；10 项控制操作强杀、2 项操作归档事务强杀、1 项装配活动指针强杀和 26 项 Provider/Assembly 生命周期强杀均未跳过。门禁不再包含远程 TLS、远程节点证明、远程派发围栏或跨主机夹具；继续固定本机 pipe-only RPC、逐操作账本与透明归档、容量健康、真实宿主 SIGKILL、Linux framed PTY 合同、helper 发布身份、结构化启动预检、运行中摘要健康、全进程树有界关闭、Linux fail-closed、统一扩展身份、MCP 精确 Package 绑定/撤销/显式回退、Scenario Process Profile、生产同进程工具及授权/输出回调拒绝、声明式合同容量/字段/显式词法前缀门禁、签名纯数据 Package 加载、严格 UTF-8、安全材料路径、本地 Skill/Knowledge/迁移正文自动装配及入口/资源材料绑定、通用 Scenario HTTP/Session/Traffic 桥接、身份/租约/URL 范围复检与秘密脱敏、Managed Provider 状态对账、Assembly 有界压缩历史、OS-backed 启动、SQLite 监督账本、Package Capability Broker、宿主归属注入、Agent Journal、SDK/Core 边界和 workspace 无循环依赖。
- 新增回归明确验证新数据库不存在 `remote_execution_%` 表；生产边界同时扫描 Execution Node Service 与 Foundation 组合根，禁止恢复远程 trust、远程配置或远程对账入口。旧数据库中的历史远程表无人读取且不自动删除。
- 最近一次完整 `test:fast` 基线仍是 241 个测试文件、2,015 项测试；本轮按此前“跳过超长测试”的决定没有重复执行整套快速回归，以完整 `verify:foundation` 113 文件/1,600 项、Server/Web Scenario 编译和 290 源码边界检查作为底座回归，并以 `test:scenario:web` 5 文件/28 项验证零配置、宿主配置、签名主服务装配、独立进程授权/HTTP、结构化同源探索、受控身份/Session/秘密正文/短期值捕获、脱敏 Traffic、逐步 CAS 状态、工件/证据关联、跨进程续跑和组合根无 Web import。另有 5 文件/47 项针对性回归覆盖 Session 加密与冻结、Scope 身份过滤、秘密 URL 边界和旧 Web Adapter 兼容。离线场景打包命令本轮已用真实临时 Ed25519 密钥、全新输出目录和 sidecar 成功执行，并确认全部 6 个运行模块进入签名材料。前一本机生命周期批次的 Linux Rust 9 项、Linux x64 交叉检查和全工作区 19 项目构建基线继续有效；真实模型、协议 2 Linux 实机重跑和 24/72 小时长稳仍按用户要求或平台条件暂缓。
- 前批 44 项多来源占用/清理证明/服务归属/强杀恢复回归通过；前批 37 项签名资源包迁移/撤销/请求快照/HTTP/强杀恢复回归通过；前批 31 项外部占用/派发屏障/授权释放/GC/重启回归通过；前批 32 项审计 codec/游标/原子补记/源引用/取消故障隔离/崩溃恢复回归通过；前批 22 项取消/身份/截止/清理回归保留；前批 29 项跨角色来源/有界压缩回归保留；前批 48 项 Skill/外部上下文/资源退役回归保留；前批资源搜索/投影 31 项、资源/MCP 47 项仍包含在回归中。此前模型验收器 14 项离线测试不能代替真实模型验收；前轮完整宿主/HTTP/模型截止/续跑调度 33 项与物理存储/受控维护/连续可靠性 44 项测试通过；此前独立 120.826 秒组合运行通过，74 次强杀及两次新宿主回读、常驻进程 234 轮。此前归档 30 项、精确恢复/授权续跑 47 项、统一容量 32 项与执行历史/取消 26 项也通过完整回归。完整快速回归与全工作区构建使用
  `env pnpm_config_verify_deps_before_run=false pnpm ...`。本轮新增 workspace package 后执行一次受供应链校验的 `pnpm install`，锁文件增加当前本地 workspace package link，未修改 `.npmrc` 或外部依赖版本。
  Linux helper 当前通过 Rust 9 项与 `x86_64-unknown-linux-gnu` 完整源码/测试图检查；Ubuntu 24.04/x86_64/Linux 6.8 的协议 1/16 类历史原生验收仍有效，但当前协议 2 增加 PTY 后必须重跑 19 类入口，尚未把交叉检查写成实机通过。临时 Linux 主机仅作为验收环境，不是当前或未来产品节点。
  本轮新增 Observer 验收 2 项、独立冷库集成 4 项、冷库真实强杀 4 项；Observer 必须在签发前证明至少两个不同 claim 的确定性、证据可复查、完整回执身份、预取消响应和宿主可观测无副作用，同一验收不能复制给另一个 Adapter。冷库不接活动 SQLite，完成签名接收、原子发布、幂等重授权、容量/路径/符号链接围栏、默认取证保留、revision 固定的解除保留、二次授权精确销毁和 `secureErase:false` 诚实声明；接收 staging/发布后、销毁准备/删除后四个 SIGKILL 窗口均由新宿主收敛。真实模型、真实外部 Observer、对象存储/异地主机以及 24/72 小时长稳仍未执行，不能把确定性 Observer 夹具写成生产事实源验收。
  此前基础批次新增 Scenario Process 持久化监督 6 项与生产重建 1 项，联合既有 Runtime/Execution Node 定向共 4 个文件、35 项；覆盖真实 OS 子进程、启动证明核对、跨 Runtime generation、跨宿主回执重放、未决结果拒绝重做、撤销/预算持久化、两代永久容量占用，以及宿主进程被真实 SIGKILL 后由新宿主恢复 generation 2。真实模型与 24/72 小时长稳仍按用户要求跳过，没有把模拟模型测试写成真实模型验收。
  本轮新增受信宿主部署/启动预检/整代切换与相邻回退 12 项底座回归全部通过；与生产 `main` 联合定向共 2 个文件、24 项通过。快速回归增加 1 个文件、12 项，底座门禁增加 1 个文件、12 项，生产边界增加 1 个源码至 270 个。
  新增回归覆盖严格无秘密清单、完整组件类别、secret reference、缺件/未知件/版本摘要漂移、默认拒绝/命令冲突/固定计划、连续 generation 和 migration chain、不可回退 Schema、管理通道、生产启动前短路、健康状态、审计不可变，以及发布两个窗口和切换三个窗口的真实 SIGKILL 恢复。
  前批新增恢复候选/重新装配/人工切换与回退 13 项底座回归全部通过；与备份、离线介质和生产入口联合定向共 4 个文件、98 项通过。快速回归增加 1 个文件、13 项，底座门禁增加 1 个文件、13 项，生产边界当时增加 1 个源码至 269 个。
  新增回归覆盖法证原件不变、候选 guard/provenance、正式暂停事件、附件复制、装配阻断和材料漂移、默认拒绝/重授权/冲突、plan/revision/generation 固定、未知文件/伪造 pointer、直接候选启动拒绝、生产 main 活动候选启动、双候选相邻回退、审计事务失败，以及候选已发布和切换各阶段四类真实 SIGKILL。
  新增回归包含脱离原控制库导入、无解密密钥公开验签、密钥/明文不落盘、分卷/签名/manifest/READY 篡改、签发者撤销过期、错误密钥隔离、默认法证保留、两步授权精确销毁、邻接文件保护、销毁审计中断重放、六类依赖证明、旧外部占用自动阻断、证明过期/失效/撤销、事务回滚、生产管理/Worker 通道和三个介质 SIGKILL 窗口。
  相邻授权升级/版本迁移/旧任务处置定向 123 项通过；归档/资料授权/原场景路由/审计定向 121 项通过（当时新增归档为 40 项），随后加入提交前状态容量回归。
  全工作区最终构建、独立底座构建和当前 diff 检查通过。本轮没有放宽失败断言、跳过新增用例或运行真实模型/超长测试。
  前批完整日志：`/private/tmp/traceforge-history-fast.log`、`/private/tmp/traceforge-history-foundation.log`、`/private/tmp/traceforge-history-workspace.log`；本轮结果由当前命令回执记录，未伪造不存在的日志文件。
  以下为前批开发过程记录，不覆盖本轮上述最终基线：
  前批新增无包依赖 Run 处置 39 项全部通过；快速回归与底座门禁各增加 1 个文件、39 项，生产边界增加 1 个源码。
  定向阶段还验证处置及相邻迁移/授权/包信任/取消共 156 项（当时处置为 28 项），随后补齐至 39 项并纳入完整门禁。
  开发中首次定向回归发现 3 项幂等重放失败：内部审计回读误传完整命令，触发严格输入拒绝；已改为精确查询身份，未放宽外部校验。
  前批完整日志：`/private/tmp/traceforge-disposal-fast.log`、`/private/tmp/traceforge-disposal-foundation.log`、`/private/tmp/traceforge-disposal-workspace.log`。
  更早批次记录：
  前批新增场景包受信装配 40 项全部通过；完整快速回归与底座门禁各增加 1 个文件、40 项，生产边界增加 1 个源码文件。
  定向既有 SDK/完整宿主/main/事件/受控来源共 99 项也通过。测试中修正 macOS 临时目录真实路径夹具与工具版本声明，未放宽生产校验。
  材料目录采用逐项读取保持枚举有界；新增测试加入显式底座门禁。原有通用测试宿主显式声明开发包模式，新增生产路径分别验证默认隔离和签名审核装配。
  前批完整日志：`/private/tmp/traceforge-package-trust-fast.log`、`/private/tmp/traceforge-package-trust-foundation.log`、`/private/tmp/traceforge-package-trust-workspace.log`。
  更早批次记录：
  前批 36 项授权升级集成回归与 2 项新增 Gateway 回归通过；完整快速基线增加 1 个文件、38 项测试和 1 个通用生产源码。
  既有授权 Adapter 单测也纳入底座门禁，因此门禁比前批增加 2 个文件、39 项测试。最后定向验证授权/Gateway/完整宿主共 62 项通过。
  开发中修正原测试直接插入 scope 后缺显式绑定的夹具、迁移错误文本大小写和审计 nullable 类型。
  新绑定增加物理准入后，旧压力测试提前在授权创建处被拒绝；现先正常创建任务，再在 Worker 启动前施压，同时另测授权创建的原子拒绝。
  上述首次失败不计通过；未放宽产品存储限制。当前 shell 使用本机已有 runtime 的 pnpm 路径，未安装或更新依赖。
  两套完整回归获准本机 HTTP/Socket 监听后全部通过；前批最终日志为 `/private/tmp/traceforge-authorization-fast.log`、`/private/tmp/traceforge-authorization-foundation.log`、`/private/tmp/traceforge-authorization-workspace.log`。
  前批迁移 48 项及其历史租约/检查点/审计修正保留，旧数据升级不在用户实际数据库上自动执行。
  前批宿主通道定向 65 项和 main 生产旧 API 门禁 1 项保留；当时的类型及非法输入测试修正仍包含在完整基线内。
  前批自定义来源定向 58 项保留；当时修正 cancellation helper 导出与新增工具夹具缺失 priority，首轮完整回归受本机监听权限限制失败，未计通过。
  前批取得监听权限后，两套完整回归重新通过，并停止受限环境中滞留的旧测试进程。
  前批治理历史归档定向 47 项保留；前批开发中修正新增测试夹具的资源预算、进程 descriptor/journal 状态与节点身份、PermissionProfile 类型；这些失败不计通过。
  原 MCP 重启用例因旧服务占用仍保留而被挡住，现显式配置第二个服务名额并断言旧占用没有消失；另增默认上限阻止再次发现的回归，没有放宽产品默认配额。
  前批首轮完整门禁与测试修改重叠，读到了旧夹具和旧路由模块，出现快速回归 2 项/底座门禁 3 项失败；停止代码修改后重跑两套完整回归全部通过。
  前批资源迁移定向 37 项通过；其物理压力/联合类型/声明生成与请求快照固定修正仍在当前完整基线内。
  前批占用回归曾因沙箱禁止本地 HTTP/Socket 监听而失败（底座门禁 68 项失败）；旧快速回归还滞留在受限监听路径，已明确终止该测试进程。
  这些结果不计通过；获得本地监听权限后两套完整回归全部通过，无跳过新增用例。
  前批开发中曾将宿主 execution owner 与 Worker ID 混用，定向回归发现后修正为当前 Worker lease/Run 校验；修正仍包含在上述完整门禁中。
  前批审计定向回归也曾受本地监听权限阻止，获准后通过；其排队模型取消隔离与旧快照恢复截止仍保留。
  前批首次完整回归发现终止请求返回 running 的异步退出路径被误判，产生 5 项失败及清理异步拒绝；这些失败不计通过。
  补齐有界终态观察与异步错误处理后，相关 21 项定向回归、全工作区构建及两套完整回归重新通过。
  前轮 CLI 启动器曾遇本机 IPC 权限限制，获得许可后重跑明确返回 `not_run / model_configuration_missing_or_invalid / modelApiCalls=0`；
  真实模型联调已按用户要求暂缓，待后续提供配置再恢复。此前 TCP 权限失败不算通过，已有监听失败即报错/清理。没有启动实际 24/72 小时测试。
- `git diff --check` 通过；本轮未提交或推送 GitHub。
- 原生 helper：Windows 6 项、Linux 9 项 Rust 测试通过；Linux x64 GNU target 的全部 Linux-only 源码及测试 `cargo check --tests` 通过；本轮 Linux crate 格式检查通过。
  Windows 原生 Job 测试已接入 `build:windows-sandbox`；Linux 真实 probe、19 类协议 2 原生矩阵和启动恢复已接入 `build:linux-sandbox` 与桌面发布前门禁。当前实机历史证明只覆盖 Ubuntu 24.04/x86_64/Linux 6.8 的协议 1/16 类，不覆盖当前 PTY 协议 2、Windows 双模式、第二 Linux 发行版/内核、aarch64 或完整生产服务/数据库重启组合。
- 核心测试覆盖黑板调度、Planner/Observer、证据图谱、模型运行时、租约与审批、Execution Node、Brokered HTTP、Tool Runtime、真实 Provider 子进程崩溃恢复和 Execution Node attestation 拒绝。
- 三项需要真实外部配置的 Live 测试不属于快速基线，发布验收时必须单独执行。
- 仓库忽略本地 `.pnpm-store` 与所有 TypeScript 增量构建缓存，避免把机器相关缓存误提交为产品源码。
- Tool Provider 控制面新增测试覆盖签名/文件与包哈希拒绝、原子只读发布、符号链接与资源上限拒绝、
  生命周期审计、隐式降级拒绝、显式回滚、调用感知排空、并发命令串行化、中断升级恢复、
  generation 提交回退以及握手身份/版本不匹配终止；Execution Node Provider fixture 的 active lease 已改为
  明确的长期有效测试值，避免测试随墙上时间跨过固定截止点后错误地只命中租约过期分支。
- Provider Archive 测试覆盖相同输入字节级复现、Ed25519 信任根验证、隔离 staging 重建、路径穿越、非规范 Base64、
  大小写碰撞、签名篡改、未知签名者、压缩 Envelope、条目数、文件数和包体积上限拒绝。
- Provider Archive Import 测试覆盖授权允许/拒绝/异常 fail closed、流式上传硬上限、原子安装、相同命令重放、不同输入冲突、
  无效归档清理、已提交/未提交中断对账、无主 upload/staging 清理审计，以及生产默认关闭本地 `packageRoot` HTTP 旁路。
- Provider Refresh 测试覆盖独立授权允许/拒绝/异常 fail closed、精确 enabled 版本门禁、成功与失败命令重放、同源命令串行、
  中断审计恢复、刷新失败保留旧目录，以及 Provider 返回与签名 Manifest 不同的完整工具目录时拒绝提交。
- Provider 生命周期故障注入覆盖安装 Manifest 事务失败后的孤儿包回收、升级/回滚激活后持久化提交失败的运行态补偿、
  目标版本提交前准入围栏、原版本重新激活和命令安全重试，并验证无效命令元数据不会先产生运行态副作用。
- Provider 激活交付测试覆盖提交后准入/交付记账失败、enable/upgrade/rollback 幂等补全、停用/隔离/替代后旧命令不再开放准入、
  新控制面启动恢复、排空失败重试不短暂开放，以及补偿启动/停用/排空失败后版本保持 failed 和关闭准入。
- Provider 归档文件系统故障注入覆盖部分接收失败审计与清理恢复、短写/零进度写入、staging 创建和条目写入失败、发布 rename
  失败、安装已提交后的清理重试，以及越界清理记录和上传根符号链接替换拒绝；故障替身测试不代替真实断电/资源耗尽验收。
- Provider 归档崩溃测试覆盖 7 个 SIGKILL 断点、磁盘 SQLite 未提交事务恢复、两次全新宿主恢复、孤儿包宽限期与回收、
  未安装版本启用拒绝，以及新进程中的导入请求重放；断点夹具只位于测试目录，不属于生产代码或场景适配。
- Provider 激活跨进程测试覆盖 26 组强杀/重启场景：三个入口的六类切换断点、升级/回滚补偿后强杀，以及完成/未完成命令
  被后续停用、隔离或升级替代；两项 Discovery 回归覆盖停用后重新激活不复用过期 revision。无真实工具调用在途。
- Invocation 恢复批次新增 30 项回归，覆盖执行权与租约、同 Work 重复执行拒绝、跨身份回执拒绝、超时/异常/存储双故障、
  旧数据库保守迁移、未知执行资源保护及六个真实 Provider 调用强杀窗口；完整 Gateway 和 Worker Runtime 回归加入底座门禁。
- Scenario Extraction 新增测试覆盖 Core 具体场景 import/身份禁入、开放 Scenario/Work/Role/Output 身份、
  空 Definition Registry/空 Catalog、Definition policy 验证、零包无场景工具、显式 Web 包工具注册、
  通用 Server 模块防回退、中性 Scope/资源授权、SDK 宿主端口、SQLite Traffic/Session Adapter 及独立 Web
  场景工具回归；Package binding 测试覆盖精确版本恢复、Schema mismatch、缺包诊断和旧数据库不伪造绑定；
  Output Schema/Evidence 测试覆盖缺失 Schema 拒绝、schema version 持久化和 Web 输出到通用图节点的幂等映射。

## 7. 最近的明确开发目标

后续按完整底座能力批次推进，继续冻结应用与场景。实际 24/72 小时长稳测试已按用户要求跳过，不等待其完成才继续开发。
内部可以拆任务实现，但交付须同时包含关联代码、
故障回归和文档，不在新增一个字段/接口后就结束开发轮次。

本轮已把真实 HTTP 宿主、嵌入 Worker、模型上下文、子进程 Provider、持久化和续跑连成有界回归，修复启动竞态、
评估身份冲突、续跑调度遗漏和模型取消等待失效。此前存储/归档/维护主链和短时可靠性入口保留。

真实模型联调：**按用户要求暂缓、未执行，待用户后续提供模型配置再恢复**。
入口和离线回归已落地，但真实模型尚未调用；此项不再作为后续开发前置条件，仍保留真实模型行为与兼容性未验证的风险。
不自动借用其他应用的凭据、不改用其他模型、不后台重试；恢复时运行正常执行和检查点重启两条短时链，并修复实际发现的问题。

本轮已完成 **多来源生产接线 + 逐进程派发屏障 + 共享配额/重启查漏 + 独立授权清理 + 查询审计/故障回归** 的组合交付。
此前 context-only 签名资源包迁移、Managed Provider 占用、共享审计、取消/截止、Skill/MCP 文本/生命周期能力保留。
没有新增具体安全场景；真实模型、原生 MCP 沙箱部署、混合资产 Scenario 安装与任意结构的跨版本转换仍未验收。
已安装兼容包之间的保留状态迁移及旧 Run 恢复已完成中性回归。

产品前提修正：TraceForge 是单用户本机/自有宿主工具，不建设账号、租户、用户管理、跨用户授权或登录 UI。
`actor` 只作为本人的操作审计标签，不是另一套用户身份；管理端口要隔离模型/工具等不可信调用来源，但不引入多用户平台架构。

本轮已完成自定义来源的**声明契约 + 严格宿主装配 + 受限 Scenario 兼容端口 + 共享额度/生命周期 + 迁移诊断/回归**。
进程端口统一计数、未核实清理不释放、重启不丢围栏，无进程操作不被错误计数。
声明不等于沙箱：底座不再发放裸节点，但无法阻止可信同进程代码使用自行导入或事先保存的外部能力；
这类任意代码隔离仍必须依赖进程外协议与已验收 OS 后端，不能虚报“所有自定义 JS 已被自动拦截”。

本轮已完成单用户宿主的**管理/Worker 能力通道 + 生产接线 + 当前租约校验 + 撤销/换票/重启失效 + 越界/正常路径回归**。
旧匿名 API 已默认拒绝；通道不进入模型/工具上下文，旧前端/桌面桥接尚未适配，不宣称 UI 端到端已验收。
程序角色隔离不是账号或多用户系统；同进程可信代码与 OS 沙箱缺口继续明确保留。

本批已完成 **保留状态迁移契约 + 当前资源/授权预检 + 生产管理入口 + 事件/绑定/审计原子提交 + 旧 Run 恢复与强杀回归**。
只支持明确兼容的已安装版本，不把结构转换或包安装算作已完成。后续本批已补齐固定授权包及保守的显式授权升级。

本批已完成 **固定授权版本 + 统一解释/生产派发复检 + 历史明确恢复/兼容升级 + 原子审计与强杀回归**。
旧授权不会仅因安装新包就被重新解释；权限语义改变不能作为兼容升级覆盖旧 scope。

本批已完成 **不可变签名材料 + 可信宿主装配关联 + 生产使用复检 + 撤销审计/重启保留**。它保护已审核材料的使用条件，不构成任意 JS 沙箱或自动代码来源证明。

本批已完成 **无包依赖取证 + 独立授权停止 + 当前收尾核对/退役回执 + 生产取消与强杀恢复**。停止不等于外部清理，退役不删除证据；大历史仍有明确上限。

本批已完成 **运行快照 + 冷热原事件回读 + 命令/租约历史保留 + 生产有界回放和强杀恢复**。档案仍在同库，不把归档当备份，不把快照当执行授权。

本批已完成 **一致数据库备份 + 可校验清单 + 显式外部依赖 + 隔离恢复 + 永久只读取证围栏 + 生产启动短路和强杀恢复**，不增加具体场景或应用 UI：

1. 活动库通过 SQLite Online Backup 生成一致副本，覆盖已提交 WAL 和同库冷正文；manifest 固定数据库、Schema、显式附件和依赖缺口摘要，禁止直接启动原始备份。Vault key、宿主配置、审核私钥、当前装配信任和未声明外部资料不自动导出，所有备份均明确 `executionReady=false`。
2. 备份/恢复根目录只由可信宿主配置，管理通道之外还需独立、带截止时间的授权；恢复请求固定已核验 manifest digest，只写新目录，不覆盖活动库或已有目的地。源文件、附件、SQLite 完整性、格式和精确文件集逐项复核，未知 sidecar、损坏、缺件或不兼容格式拒绝。
3. 恢复副本安装不可变 `inspection_only` 围栏。生产入口在 MCP、模型、Vault、Execution Node、包、Worker 和任何启动恢复构造器之前短路，只开放有界 Run/事件/执行占用取证；旧 lease、reserved/unknown 占用和 uncertain 调用不释放、不重放，也不伪造清理证明。
4. 操作命令和阶段审计不可变；相同请求重授权后只复核既有发布，冲突拒绝。发布前中断残留保持隔离且不自动删除，发布后最终审计中断可复核补记、不重复恢复。容量/权限/路径/摘要/Schema/投影故障、新控制库和真实新宿主、三个 SIGKILL 窗口均有回归。

本批继续完成 **加密签名离线介质 + 默认法证保留/精确销毁 + 恢复激活前核对**，仍未增加具体场景或应用 UI：

1. 已发布本地备份可导出为 AES-256-GCM 独立分卷和 Ed25519 签名 manifest；复制到独立存储后，可以只凭固定摘要与当前公钥核验，不依赖原控制库或解密密钥。导入使用可信宿主提供的对称密钥，在新目录重建并重新走完整备份校验后才发布；密钥和私钥不进入介质、HTTP、模型、工具或审计正文。
2. 备份和介质默认 `forensic_hold`。解除、重新冻结和销毁都要求独立授权；销毁必须先预览并固定 revision、精确文件清单和指纹，只删除已验证目标，不递归扫目录。符号链接、内容变化和未知残留一律保留现场；崩溃后按已落账步骤对账，不重复误删，也不虚报底层安全擦除。
3. 恢复宿主用独立可写审计库逐项核对 Vault key、Scenario 材料、上下文资源、模型配置、MCP/Provider 配置和外部副作用。证明有指纹、时效、撤销与失效状态；旧库仍有 lease、进程/Managed 占用、uncertain 调用或运行中模型事实时自动阻断。即使六项全部满足，也只得到 `review_complete_but_locked`，恢复库仍只读、围栏仍在、没有激活路由。
4. 三条控制链均接入生产管理通道、默认拒绝授权、有界容量、幂等冲突、不可变审计和故障恢复；离线介质覆盖发布前、已发布未补审计和已完成三个真实 SIGKILL 窗口。隔离残留只进入库存，不会被容量压力自动删除。

当前边界：离线格式解决加密搬运和独立验真，但对称密钥分发/轮换、真实移动硬盘或异地对象存储、OS 账号隔离和底层安全擦除仍是部署责任；不提供解除恢复围栏或自动重新执行。详见[底座备份与灾难恢复](architecture/foundation-backup-and-disaster-recovery.md)。

本批继续完成 **恢复候选库 + 当前可信依赖重新装配 + 人工活动指针切换/回退**，仍未开发具体场景或应用 UI：

1. 只读取证恢复库保持逐字节不变；候选从它复制到独立私有目录，在副本内写入不可变来源 provenance 和 guard。直接指定候选数据库仍被 `CANDIDATE_ONLY` 拒绝，不能绕开可信宿主活动指针启动。
2. 候选创建固定完整 readiness digest，对 Vault、Scenario 材料、上下文资源、模型、MCP/Provider 和外部副作用逐项调用可信重新装配端口，只保存材料指纹/引用，不保存秘密。证明过期、材料变化、装配缺失或旧外部占用都会阻断发布、预览和重启。
3. 原恢复中仍为 running 的 Run 通过事件链追加系统暂停事件，保留原事件、Work 和证据，而不是直接改投影；候选切换后也不自动 resume、不重放工具。缺少当前 Scenario 包时生产恢复只报告诊断，不猜旧包或改写历史。
4. 激活/回退先预览并固定候选 revision、pointer generation、来源和 plan fingerprint，再独立授权、落 `switch_prepared`，最后原子替换活动指针。生产 `main` 在模型/MCP/Provider/Execution Node/迁移之前解析并复核 pointer；回退只允许紧邻的上一个活动候选。
5. 新增候选发布、装配失败、来源/附件/未知文件/指针篡改、直接启动拒绝、双候选回退、生产 main 启动、默认拒绝/重授权/冲突、事务失败和四类真实 SIGKILL 回归；发布后或指针后审计中断可补记，不重复复制或切换。

当前边界：活动 pointer 与装配 callback 依赖可信宿主和 OS 目录权限，不是对同账号攻击者的防篡改签名；装配引用不复制 Vault/模型/MCP 秘密，也不证明远端服务长期在线。真实断电、跨卷切换、Windows rename/ACL、密钥轮换恢复和实际异地介质仍待部署验收。详见[底座备份与灾难恢复](architecture/foundation-backup-and-disaster-recovery.md)。

本批已完成 **受信宿主部署清单、启动预检与整代升级/回退**，未开发具体场景或 UI：

1. 新增严格、无秘密的 `traceforge-foundation-deployment-v1` manifest，固定底座、数据库 Schema、原生 Helper、信任根、Scenario、Skill、知识资源、MCP/Provider、模型配置、容量策略和恢复身份；凭据只允许 `host-secret://` 引用，类别遗漏、重复身份和 migration 目标不一致均拒绝。
2. 新增受信 inventory adapter 和有界 preflight，区分 required 缺件、未知额外组件、版本/摘要漂移与 secret reference 缺失。生产 `buildServer` 在打开/迁移数据库、连接 MCP、初始化模型和启动 Execution Node 之前强制执行；健康状态只暴露非秘密 generation 身份。
3. 新增不可变 staged release、连续 deployment generation/migration chain、独立授权、固定 preview/plan fingerprint、原子活动指针、紧邻 release 回退和 rollback-compatible Schema 校验。发布目录和审计有容量上限，命令冲突与默认拒绝已覆盖。
4. 新增生产启动、管理通道、清单篡改/漂移/缺件、完整 generation 切换、回退，以及发布两个窗口和切换三个窗口的真实 SIGKILL 回归；指针已切换但终态审计未落时只补审计，不二次增加 generation。详见[受信宿主部署说明](architecture/trusted-host-deployment.md)。

通俗作用：宿主现在有了一张经过审核的“整机装箱单”。启动前会核对代码、数据库、沙箱、插件、Skills、知识资料、MCP 和模型配置是不是同一套；少件、多出未知件或版本对不上都会在真正运行前停下。升级按整代切换，失败只能退回紧邻上一代，不会悄悄拼出半新半旧的运行环境。

本批已完成 **CyberSecurity Harness 两段边界重构 + 通用 Artifact/State**，未开发具体 Scenario 功能或 UI：

1. 新增无 Server/SQLite/Execution Node/Scenario 依赖的 `@traceforge/agent-runtime`；`AgentSession` 实际接管回合预算、取消检查、Model Intent → 可审计 Intent → Observer 顺序，以及工具 Intent 去重/可用性判定和工具 Observation 的审批、成功、失败、连续失败终止策略。`WorkerHost` 继续只落真实副作用、恢复 checkpoint 和控制面结果。
2. `ScenarioToolHostContext` 已移除 Session、Traffic、Cookie 和原始 `ExecutionNode`。Web 包自行声明两个版本化 Host Capability；通用 Foundation 不创建 Web 端口、不知道 Web 能力 ID，产品入口安装 Web 包时才显式绑定现有 Adapter。
3. Web HTTP 工具不再提交或伪造 request attribution/permission，只能调用 invocation-scoped `GovernedExecutionPort`；宿主统一生成请求身份、注入权限并执行所有权/截止检查。
4. 新增 framework-only Agent Harness integration host 和自动边界门禁，证明无 Fastify、SQLite、Web Scenario 也能完成带证据引用的 Work，并禁止 Agent Runtime 反向依赖 Worker/Server/Execution Node/具体场景以及 Scenario SDK 重新暴露 Web transport Contract。详见[Agent Harness 与 Worker Host 边界](architecture/agent-harness-boundary.md)。
5. Scenario SDK 新增无场景词汇的 Artifact/State Contract；生产 Foundation 装配独立 SQLite Store。Artifact 保存内容引用、摘要、SHA-256、大小和有界元数据，State 使用有界 JSON、revision compare-and-set 与命令结果重放；两者都有每 Package 精确版本的记录总量上限，完整关闭并重开数据库后仍可恢复。
6. Registry 将 Artifact/State 端口固定到接收端的 Package id/version，跨包或跨版本访问在进入 Store 前拒绝；Store 查询继续按 Package/版本/Case/Run 隔离。命令重放返回原结果，复用相同命令修改输入会冲突，不会静默覆盖。
7. 已删除 `LeaseWorkerRuntime/LeaseWorkerOptions` 兼容导出和全部调用，边界脚本会阻止旧名称或通用 Artifact/State Contract 被后续修改恢复/删掉。
8. 新增 `traceforge-agent-execution-journal@1`，认知状态从 Worker checkpoint 顶层迁入 Agent Runtime 定义的版本化 Journal；稳定 Session 身份只由 Run/Work 决定，不绑定 Worker、lease、Server、SQLite 或具体 Scenario。
9. v3 Host Checkpoint 只保存 Journal、执行归属、pending Invocation 和 pending Control command；v1/v2 在 Host Adapter 中单向迁移。Journal/旧字段混放、非法终态、重复 Intent、过深/非 JSON 输入、超大正文/条目/引用和整体超过 1 MiB 均拒绝。
10. 完成/阻断在调用控制面前先落 Agent 终态与精确控制命令。同租约强杀重启直接幂等重放，不再调用模型或工具；completed 命令跨租约关闭，显式重新租赁的 blocked Journal 才可清除旧终态继续。
11. framework-only 测试覆盖 JSON 序列化搬迁到另一 Store、替换 Worker Host 后恢复；生产新增 `terminal-committed` SIGKILL 窗口，与 pending、receipt、result 三个旧窗口联合证明副作用仍为一次。
12. 新增 `traceforge-scenario-process-rpc@1` Scenario 专用进程 Profile；Package 必须在同进程工厂和进程声明中二选一。包合同只声明入口身份和能力，可信宿主独立提供可执行路径、环境、服务归属、权限 Profile 与资源上限；生产装配不再接受配置自报的沙箱证明。
13. 新增 Package Capability Broker，反向 RPC 只能绑定仍存活的父工具调用。Package/版本/进程代次、Case/Run/Work/Worker/lease、能力/动作、请求响应容量、并发和截止均复检；子进程伪造归属、未声明能力、旧代次和过期租约全部拒绝。
14. 授权、证据、Artifact、State 已有通用 Host Adapter；Package id/version 与 Work 归属由宿主注入。能力调用支持并发同键合并、跨进程代次回执重放、异键冲突拒绝和运行中撤销。
15. Scenario 进程工具进入 Foundation 共享公平调度；损坏帧关闭进程，崩溃与真实 SIGKILL 只能在重启预算内生成新代次。生产装配识别进程型 Package，不再调用其同进程工厂。详见[Scenario Process Runtime 与 Package Capability Broker](architecture/scenario-process-runtime.md)。
16. 生产 Scenario Process 已改走 `ExecutionNodeToolProviderClient`：真实启动后核对进程归属、节点/PID、沙箱后端、权限指纹、资源上限指纹和网络模式；每一代使用独立 OS 执行幂等身份。开发专用直启仍只用于协议测试，Foundation 遇到它会拒绝装配。
17. 新增 SQLite 监督账本，持久化 Package 精确版本、清单/启动指纹、单调 generation、reserved/started/ready/exited/failed/interrupted/revoked 状态及跨宿主重启预算。启动时把未终结代次保守标记为 `interrupted`；同版本修改清单、启动材料或预算会拒绝继续，不能靠重启应用刷新次数。
18. 能力 Broker 在调用宿主 Handler 前先持久化 `pending` claim，成功后再提交完整回执。新 Runtime/新宿主可重放已完成回执；若中断发生在两次写入之间，后续请求被标成结果未知并阻断自动重做，同键换输入继续冲突。
19. 每个 Scenario 进程 generation 已进入现有 `ProcessExecutionCapacity`、公平调度和 Execution Node 进程观察链。正常退出、失败和撤销会结束本地 lease，但主进程终结只形成保守占用，仍需既有独立清理证据才能释放；因此宿主重启不会洗掉 OS 占用风险。
20. 监督/代次/回执表具有记录数、单条大小和物理磁盘准入；生产边界门禁固定 Execution Node、持久化 generation、未完成能力围栏和 Host 归属注入。生产装配回归证明真实子进程正常关闭、重建 Runtime 后 generation 从 1 增至 2、同一能力不二次派发，并保留两代进程容量记录。
21. 未决能力现在在任何 Host Handler 执行前保存完整、无原始输入的通用 claim：Package/版本、generation、父请求、能力/动作、输入指纹和 Case/Run/Work/Worker/scope/lease 均固定。旧宿主中断后，普通错误、重启或本地超时不能解除 `pending`。
22. 新增 Ed25519 签名恢复证据合同和独立授权运维入口。部署侧恢复权威按 Package 与能力显式限域；签名、时间窗、claim 和回执归属全部核对。只有外部事实证明成功才补写回执，证明从未执行才转成 `retry_allowed`；同键重试必须保持原身份/输入，只允许 generation 与开始时间前进并累加 attempt。
23. 新增 Scenario Process、generation、能力记录、控制审计和退役档案的有界分页查询。命令固定指纹、拒绝默认授权、证据与审计不可变；运维清单只暴露状态、摘要、归属和引用，不返回原始调用输入或输出。
24. Package 版本退役已与撤销和进程清理链串联：必须先撤销，等待 generation 终结、所有 Scenario Process 容量占用获得既有可信清理证明、且没有 `pending` 能力，才可受权退役。完整热回执进入同库 gzip 不可变档案，热表只保留永久防重放身份/摘要并释放活跃回执配额；档案读取会重新校验压缩长度、摘要和 Package 身份。
25. 新增部署侧 `ScenarioCapabilityRecoveryIssuer`：通用 Observer 接口只提交外部事实结论、原回执和稳定证据引用；Issuer 固定 Package/能力范围、观察截止、Ed25519 私钥、key generation、有效期和最大证据年龄。私钥不进入 HTTP、SQLite 或审计，Observer 的具体判断逻辑不进入 Core。
26. 恢复 key 支持并存换代和动态撤销。Issuer ID/key ID 冲突、外部权威与本地 Issuer key 重叠、过期/越界/撤销 key、超时观察、身份不一致回执均 fail closed；旧 key 撤销后旧证据不能继续对账，新 key 可对同一未决 claim 重新观察签发。
27. 退役档案新增独立授权的签名导出。输出固定 Package/版本、档案摘要、原始/压缩大小、创建/导出时间和压缩正文，并由独立 Ed25519 export key 签名；接收校验重新执行 Base64、签名、解压上限、长度、摘要和内部身份检查。每次重放仍重新授权，export key 撤销后旧包不再被当前权威接受。
28. 新增四个真实宿主 SIGKILL 窗口：对账证据事务未提交/已提交、退役档案事务未提交/已提交。全新宿主分别重新完成或精确重放命令，SQLite 完整性、单份证据、单份档案、最终能力/版本状态均保持一致；测试夹具不属于生产签发器或具体场景。
29. 新增 `ScenarioCapabilityRecoveryObserver` 部署验收契约。至少两个不同 claim 必须重复产生完全一致的观察，稳定证据引用须由部署读取器复查并匹配预期摘要，成功回执逐项绑定 Package/版本/generation/父请求/能力/动作/幂等键/输入指纹；可信宿主快照还须证明正常与取消观察没有可见写副作用。验收绑定同一对象实例、有明确到期时间，复制结果或更换 Adapter 后必须重新验收，Issuer 未取得有效验收一律拒绝签发。
30. 新增可选 `ScenarioProcessColdArchive` 与 Foundation 管理路由。独立根目录不读取或写入活动 SQLite；签名包经重新授权、权威有效性、Base64/签名/解压上限/长度/摘要/内部 Package 身份核对后，使用同目录 staging、文件及目录 `fsync` 和原子 rename 发布。命令回执固定请求指纹且重放重新授权；归档目录只接受固定文件和 SHA-256 名称，符号链接或未知条目 fail closed。
31. 冷库默认永久 `forensic_hold`，不按场景或墙上时间自动删档。必须先用期望 revision 独立授权解除保留，再用另一条独立授权命令进入 `purge_prepared` 并精确删除目标目录的固定文件；旁边档案不受影响，记录明确 `secureErase:false`。接收 staging/发布后和销毁准备/文件删除后四个真实 SIGKILL 窗口均可由新宿主收敛，未完成 staging 不冒充档案，已删除证据不会恢复。
32. Execution Node 协议提升到 1.8。该批曾实现并验证远程 TLS/节点证明/派发围栏；2026-09-02 明确产品不需要远程节点后，相关产品代码、配置入口、管理路由和发布门禁已在第 36 项定向撤回。历史事实保留在记录中，但不再构成当前架构或完成度。
33. 新增真正的 `traceforge-linux-sandbox` Rust helper 源码与 Linux x64 发布链：`clone3` 创建即加入 cgroup，独立 user/mount/pid/ipc/uts/network namespace，tmpfs + bind/mask + `pivot_root` 文件策略，清除 capability，seccomp 封锁逃逸/重挂载面，目标环境白名单编码，CPU/内存/进程/写 I/O 监控以及 `cgroup.kill` + 空树屏障。宿主只有在显式 cgroup delegation、启动残留恢复和真实 probe 成功后开放能力；Linux 桌面构建、资源复制和发布校验缺一项即拒绝。
34. 完成首个真实 Linux 平台闭环：Ubuntu 24.04/x86_64、Linux 6.8、cgroup v2、systemd 255 上以专用非 root 账号和 `Delegate=yes` 运行。新增固定 root-owned helper 路径的 AppArmor `userns` Profile，未全局关闭 Ubuntu 防护；同一运行 ID 关联 cgroup/scratch，启动 `recover` 只清理受控前缀，存活残余先 `cgroup.kill` 并等待空树。16 类原生验收覆盖文件读写/deny、环境隔离、软链接与非规范路径、读写/拒绝重叠、断网、seccomp、孤儿进程、CPU/内存/进程/写入超限、不支持网络/cgroup 配置拒绝、helper 与 Execution Node 父进程 SIGKILL、死亡传播及新宿主恢复，全部通过，最终活动 cgroup/scratch 均为 0。实机发现并修复 PID namespace 父 PID 判断、合并 `/usr` 顶层运行时别名、资源事件基线和多行 cgroup 字段解析问题；Linux release 构建现强制跑完整矩阵。环境、helper SHA-256、证据与适用边界记录在 [首个 Linux 原生验收记录](validation/linux-native-ubuntu-24.04-x64.md)，但该记录不是独立签名的生产 attestation。
35. 完成 **进程控制逐操作可靠性**：stdin、PTY resize、signal、terminate、adopt 均要求稳定 `operationId`，生产 Execution Node 在产生副作用前以有界 SQLite 账本原子 claim，完成后保存可回放响应；换内容复用 ID、仅有 claim、持久记录损坏均 fail closed。该能力最初曾通过远程 TLS 子进程验证提交后、响应前 SIGKILL；第 36 项撤回远程链后，只保留适用于本机 IPC 断开、Execution Node 或应用崩溃的逐操作身份、节点账本和回放语义。
36. 完成 **远程 Execution Node 定向撤回与本机主链收口**：删除远程 trust wrapper、TLS/证书固定分支、远程派发围栏与对账控制面、Foundation 远程配置入口、跨主机测试夹具及发布门禁；RPC 地址收窄为用户本机命名管道，不再暴露 TCP/TLS 地址类型。保留本机进程隔离所需的 RPC token、并发/帧/截止门禁、逐操作 `operationId` 与 SQLite 节点账本、PTY/signal/terminate/adopt，以及 Linux 原生 helper。新数据库不创建远程表；旧数据库可能保留无人读取的历史表，不做破坏性删表。
37. 完成 **本机 Execution Node 发布身份、启动健康与关闭清场闭环**：新增严格 `traceforge-native-helper-release-v1` 清单，Linux/Windows 构建原子写入平台、x64、后端、协议、文件名和 helper SHA-256，桌面出包与运行时共用校验；打包启动强制要求相邻清单。启动预检结构化区分平台/架构、缺件/权限、清单漂移、Linux runtime 配置和 native probe 失败，Linux 先执行受控残留恢复并报告清理数量。`/api/health` 暴露无路径/无秘密的节点状态，每次检查重新量取 helper，运行中替换立即降级且 Launcher 继续逐执行 fail closed。节点关闭先停 RPC，再等待并发启动收敛、强制终止全部受管进程树并要求有界退出证明；进入关闭后拒绝新进程。桌面更新关闭“下载后随普通退出自动安装”，避免未经明确操作切换 helper generation；Linux DEB 安装器级材料回滚由第 49 项补齐，通用桌面自动更新仍暂缓。
38. 完成 **本机进程控制跨宿主崩溃矩阵**：新增独立真实 Node 宿主、用户本机 pipe、真实 SQLite/WAL 和确定性受管进程副作用夹具，对 stdin、PTY resize、signal、terminate、adopt 五类操作分别在“claim 已提交、尚未执行”和“副作用及完成响应已提交、RPC 尚未回复”两个边界执行 `SIGKILL`。新宿主以相同节点身份重开账本后，前者保持结果未知且副作用为零，后者精确回放已提交响应且副作用仍为一次；adopt 同时证明新 token 不会因重放再次轮换。该夹具证明本机 IPC、逐操作账本和新宿主恢复语义，不冒充 Linux/Windows 原生沙箱验收，也不引入远程节点。
39. 完成 **本机执行底座生产闭环的仓库实现**：Linux helper 协议提升到 2，新增与 Windows 共用控制器语义的 framed PTY，复用原有原子 cgroup 加入、namespace/tmpfs 文件边界、seccomp、资源监督、`PDEATHSIG` 和空树屏障；生产 Service 同时装配 Linux stdio/PTY，并在每次启动前重验 helper measurement。Linux 原生验收入口从 16 类扩为 19 类，增加输入/resize/terminate、Ctrl-C 与 close-input/EOF；当前 macOS 已通过 Rust 9 项、Linux x64 完整交叉检查和 TypeScript 合同，协议 2 的 Linux 实机重跑仍是发布门槛。逐操作 SQLite 账本新增 24 小时默认热保留、有界 gzip 归档、精确透明回放、摘要/解压上限/损坏拒绝、活跃/总量/字节/物理空间准入与无秘密健康摘要；未知 claim 永不归档。归档提交前后两类真实 `SIGKILL` 证明重启只出现完整热记录或完整归档。Foundation 边界固定 PTY、操作归档与故障门禁；完整 `verify:foundation` 110 文件/1,555 项通过。本批不包含远程节点、桌面更新、具体场景或应用 UI。
40. 完成 **受控扩展装配与信任生命周期闭环**：新增统一、无秘密的 `traceforge.extension-assembly.v1`，以精确 Package、Skill、Knowledge、MCP Tool/Context Profile、Package Process Provider 和 Managed Tool Provider 单元记录内容/契约摘要、生命周期状态及依赖闭包；不可变 Profile 身份、装配快照、单调 activation 和活动指针进入有界 SQLite 与物理空间准入。MCP Tools 不再是宿主全局能力，Profile 必须声明精确 Package 版本，能力名相同的另一个 Package 也不能借用；相同 reviewVersion 不能换身份或扩权。MCP Tool/Context Profile 新增默认拒绝、逐次授权、不可变且重启保留的精确撤销，执行链在发现/启动/发送/响应各关键边界复查，撤销后不启动新进程、不缓存或投递返回。低版本 Profile 默认拒绝，只能凭受信宿主的整代 Deployment rollback 同步证明记录回退；可信部署清单新增必填 `extension_assembly` 组件。现有 Managed Provider 的签名 manifest、签名者与 installed/enabled/draining/disabled/quarantined/failed/collected 状态会在成功控制命令后同步更新同一 Assembly generation，直接存储变化也会在读取时对账，不把本机安装路径写入清单。Package Process 单元同时固定签名 runtime manifest 与 Host 启动材料摘要，原始路径/环境不落库，同一 Package 版本偷换启动配置会在执行前拒绝。Provider 状态提交、排空/失败补偿、装配同步和启动恢复之间的 26 个真实 `SIGKILL` 窗口均在新宿主对账到完整 generation；装配活动指针切换强杀也只保留旧代或完整新代。历史容量新增默认拒绝、逐次授权的同库有界 gzip 归档，保留活动代和最近 32 个热代，旧 activation/snapshot 只有在归档正文、摘要、索引和审计同事务提交后才释放，并可按 generation 完整校验回读；这不是独立冷对象库或备份。回归还覆盖运行中撤销、跨 Package 拒绝、Provider 状态代次、进程启动材料替换、隐式降级、归档重放/冲突/热窗口保护和审计不可改写。本批没有添加场景常量、远程节点、账号/租户或桌面更新。
41. 完成 **生产 Scenario 工具执行强制进程化**：Foundation 和 `GovernedExecutionSources` 默认在调用 `createToolSources` 前拒绝任何同进程 Scenario 工具工厂，已审核签名不构成绕过理由；生产工具正文只能声明 `ScenarioProcessManifest`，经本机 Execution Node、真实沙箱证明、持久监督、共享容量和 Package Capability Broker 运行。SDK 直接 `toolSources` 也改为逐调用显式开发 opt-in，防止其他组合根误用；Foundation 的兼容开关默认关闭并在容量诊断中明确显示 `disabled/development_opt_in`。中性回归证明默认拒绝时工厂调用次数为零，明确开发夹具仍可运行，正式 Scenario Process 的宿主 State 能力、版本归属、重启回执去重和运行期撤销保持有效。本批不修改应用层或任何具体安全场景。Package Definition、授权解析与 Output Schema 回调仍是可信宿主编译代码，尚未声明式化，因此本项不能扩大表述为“任意 Package JavaScript 已隔离”。
42. 完成 **生产 Scenario 授权、输出和证据映射声明式化**：SDK 新增 `traceforge.scenario-scope-policy.v1` 与 `traceforge.scenario-output-contract.v1` 固定解释器。Scope 只可声明静态允许/拒绝动作、有界 JSON 和固定值/`payloadPath` 资源规则；Output 固定 kind/version、摘要/引用容量及引用前缀，并可用白名单 selector 映射证据字段。未知字段、未知 selector、非 JSON、递归/字节/数量越界和未授权资源均 fail closed，不支持表达式、正则或任意转换代码。完整合同进入 Package 信任摘要、Scope 固定绑定和 Run 迁移兼容判断，相同 kind/version 但规则不同也拒绝。Foundation 生产默认拒绝旧 `parseScope`、`authorizeResource`、`validate`、`mapToEvidence` 回调，并以 `legacyScenarioContracts: disabled/development_opt_in` 暴露唯一显式测试/迁移兼容开关；与生产同进程工具工厂门禁相互独立。本批仍不修改应用层和具体安全场景。
43. 完成 **签名纯数据 Scenario Package 描述文件加载链**：新增 `traceforge.scenario-package.v1`，用 `scenario.json` 表达 Package/Definition、声明式 Scope/Output、Skill/Knowledge/MCP 引用和 Scenario Process 清单。SDK 解析器限制 1 MiB/32 层并逐层拒绝未知字段、回调、表达式、非法类型和路径逃逸，复用 Registry 校验引用后深冻结整个对象。Server 加载器只从真实绝对审核根读取清单声明的 `scenario.json`，使用 `O_NOFOLLOW`、字节数和 SHA-256 防替换；进程 `package://` 入口必须是材料唯一 `entry`，本地 Skill/Knowledge/迁移资源必须对应摘要一致的 `data` 文件。描述身份同时匹配材料和审核，官方加载对象保留内存来源证明，因此无需宿主再手写 `assertAssembly`；手工旧对象继续要求显式关联。Foundation 提供与预装 Registry 互斥的加载开关，并立即进入原有签名、当前信任、撤销、Extension Assembly、Execution Node 和运行时复检；失败版本隔离且不启动。描述文件不能选择宿主可执行程序、环境、权限、资源上限或沙箱后端。本批没有应用层、具体场景、下载器、远程节点或桌面更新改动。
44. 完成 **底座完成度审查与数据包资源生产接线收口**：沿 Foundation 真实组合路径核对 Package、Skill/Knowledge、MCP、Scenario Process、迁移、Model、Tool、Execution 与恢复能力，修复数据描述包仍需宿主重复提供本地正文和迁移信任的断链。当前受信的本地 Skill、Knowledge 和 migration data 会从同一审核材料自动读取，复核安全相对路径、data 角色、单文件 64 KiB、稳定 inode/size/mtime、SHA-256 和严格 UTF-8，再进入既有不可变 Context/迁移存储；加载后替换、路径逃逸、摘要错配均拒绝。外部 MCP Profile、进程可执行程序/权限/沙箱及模型配置仍由可信宿主提供，防止 Package 自行扩权。审查确认 Core/Foundation 已达到首个真实场景接入条件；`main.ts` 的 Web 硬编码和旧 MCP 直连是下一阶段应用装配欠账，本批按冻结边界未修改。详见 [通用安全智能体底座完成度审查](architecture/foundation-completion-audit.md)。
45. 完成 **首个 Web 黑盒场景的数据化、进程化接入**：应用组合根删除 `WEB_BLACKBOX_PACKAGE`、Web Host Capability 和生产依赖，不再默认创建 Web Session/Traffic Adapter；新增严格 `traceforge.scenario-host.v1` 本机部署配置，缺失时零场景启动，从中装配审核材料、公钥与 Scenario Process 启动 Profile。Web `0.2.0` 以 `scenario.json` 声明 Definition、Scope、Output/Evidence、Skill、Knowledge 和进程清单，子进程提供 Scope Snapshot 与有界 HTTP 请求；HTTP 先经精确资源授权，再通过新增的通用 `traceforge.scenario.execution@1` Host 能力进入本机 Execution Node，沿用 Case/Run/Work/Worker/lease、权限、截止、响应容量和网络回执，不获得裸网络或底座对象。离线 `scenario:package` 命令可复制精确材料、生成 SHA-256 清单、Ed25519 审核和宿主 sidecar，私钥不随包交付。回归覆盖零配置、严格宿主配置、组合根无 Web import、真实描述解析、独立子进程反向授权/HTTP，以及主服务从临时签名安装加载真实 Web Definition。本批没有远程节点、多用户、桌面更新、浏览器直连或漏洞特判。
46. 完成 **Web 黑盒结构化 HTTP 探索与证据闭环**：Web Package 进程新增 `web.surface.explore`，一次调用最多执行 8 个受控 GET；在场景内完成 HTTP(S) URL 规范化、同源 `href/src/action` 发现、去重队列、内容类型判断、正文摘要、外部 origin 清单和明确覆盖统计。每个 URL 都独立申请 `network.url` 授权，经本机 Execution Node 获得 Network Receipt，再记录带正文摘要哈希的 Artifact 与 Evidence；每个尝试后把队列、已访问项、观察和跳过项通过 revision CAS 写入 Package 私有 State，新进程可从相同 Run 续跑。队列、历史、链接、摘要和响应均有硬上限，正文不复制进场景状态。SDK 仅新增领域无关的显式词法前缀资源选择器，底座不解释 URL/路径语义；Web 包用预先规范化的 `urlPrefixes` 表达授权范围。本批没有 Browser、登录凭据、漏洞 Payload、应用 UI、远程节点或多用户逻辑。
47. 完成 **Web 黑盒受控认证会话与脱敏流量闭环**：Web Package 升至 `0.3.0`，新增身份目录、Session 打开/请求、认证探索和当前 Run 流量快照。Package 只接收 Scope 允许的身份/Session 描述符和命名秘密句柄；Vault 中的秘密头、Cookie、表单/JSON 字段只在 Host 内解密、按显式 URL 前缀和 Cookie 规则注入，短期文本值以最多 16 个精确分隔符捕获并加密回写，场景进程只收到名称。每次 Session 使用重验 Case/Run/Scope/身份版本/有效期/当前租约，同一 Session 不能跨有效租约并发转交；撤销或失效会冻结。认证响应移除 `Set-Cookie` 并替换已知秘密，Traffic 只保留请求头存在性、秘密模板或正文摘要以及身份版本、Network Receipt 和 Run 归属。通用 SDK/Foundation 只增加声明式 Session/Traffic 能力 ID 和按 Package 声明的惰性 Adapter，不包含登录流程或 Web 字段语义；旧应用身份路径未在本批迁移。本批没有 Browser、应用 UI、远程节点、多用户或漏洞特判。
48. 完成 **继续开发前的三个 P0 同批整改**：Electron Main 取得随机、内存态管理 capability，只对当前 loopback Server 的 API/WS 注入；模型配置改为无秘密元数据，Desktop 使用系统 `safeStorage`，独立 Server 使用 AES-256-GCM Vault/环境覆盖，旧明文自动迁移，明文取回路由彻底删除。生产入口删除旧 `McpManager/connectAll` 和 `/api/mcp/tools`，旧配置仅诊断，MCP Tool/Context 只保留既有受治理路径。Web 正式源码删除手写 Definition、`0.1.0` 同进程工具、Web Host ports、Playwright/direct Browser 和旧工具测试，Kernel/Scheduler/Server 测试改从真实 `scenario.json` 读取 Definition，包身份统一为 `0.3.0` 数据描述 + Scenario Process；边界门禁阻止这些旁路回归。相关构建、针对性测试、离线 LLM Secret 测试和 Host Control/MCP 短集成测试通过；真实模型与长稳仍按决定暂缓，完整快速套件因受限环境 socket `EPERM` 中止，不记为通过。
49. 完成 **Linux Desktop 部署链仓库闭环**：正式 Linux 发行物收窄为 DEB-only，安装钩子以 root-owned 固定路径装入 helper/release manifest 和 AppArmor Profile，加载策略后安装 `/usr/bin/traceforge`；升级任一步失败会恢复上一代 helper、manifest、Profile 和 launcher，卸载不删除用户数据。启动器以当前登录用户创建 `Delegate=yes` 的瞬态 systemd user scope，把监督进程移到 `supervisor` 子 cgroup，在空 scope 根启用 cpu/io/memory/pids，并交付 mode-0700 用户 scratch；没有系统 daemon、产品账号、远程节点或多用户功能。Desktop 直接/便携启动明确报告 `linux_deployment_not_installed` 并关闭 Sandboxed Process，不能把随包 helper 当作部署证明。跨平台静态验收、shell 语法、生命周期 4 项测试和 Server/Desktop 编译通过；协议 2/19 类、真实 DEB 安装/卸载/失败升级仍等待 Linux x64 真机，不能由本机检查冒充。
50. 完成 **Runtime 下沉与 Web 构建整改第一大批**：把上下文血缘的纯投影和 Planner/Observer 共用上下文装配迁入 `@traceforge/cognitive-runtime`，删除 Server 私有装配文件；Server 只采集 SQLite Tool Receipt、Package Context、Snapshot 和 derivation 等宿主事实后调用通用 Runtime。Web Scenario 把原 309 行手写 `runtime/main.mjs` 拆为合同、RPC、校验、HTTP/Session/Traffic、Surface/HTML 和入口 6 个 TypeScript 模块；构建会二次编译逐字节验真，打包器自动收集完整入口闭包并作为同一签名材料集合。24 项针对性测试、相关编译、离线真实 Ed25519 打包和 Foundation 构建通过；没有把 Web、URL、登录或漏洞语义写入 Core。Planner/Observer 内剩余决策/监督逻辑与 Fastify/SQLite Adapter 的分离仍是下一优先级。
51. 完成 **Planner/Observer Runtime 整体下沉**：结构化决策合同、通用提示词/模型请求、上下文授权复检、认知快照生命周期、Planner 合法性校验、Observer 语义去重、循环调度、并发冲突重试和幂等 Run 命令应用进入 `@traceforge/cognitive-runtime`。Runtime 只消费通用端口，不依赖 Fastify、SQLite、LLM 实现或具体 Scenario；Server 原 470/392 行文件分别收窄为 83/94 行 SQLite/HTTP Adapter，产品 Composition 直接装配 package 类。无 Server 测试 2 项与既有 4 文件/26 项集成回归通过，合计 5 文件/28 项；Foundation 的 15 packages、Server 编译和 292 源码边界检查通过。下一项是提取 Structured Worker Model，不移动 WorkerHost 的工具副作用和租约所有权。
52. 完成 **Structured Worker Model 下沉与认知模型层收口**：Worker 提示词、Invoke/Complete/Block 决策合同、上下文裁剪/压缩、认知快照、受治理模型路由、取消检查、排队后授权复检和来源派生记录进入 `@traceforge/cognitive-runtime`。删除 Server 原 146 行实现，Embedded Worker 直接消费最小 JSON Model Port；没有把 WorkerHost 的租约、工具副作用、Checkpoint 或结果提交移入模型层。三类认知角色联合短回归 9 文件/48 项、Foundation 的 15 packages、Server 编译和 292 源码边界检查通过，边界门禁禁止实现返回 Server。整改计划第 5 节至此完成，下一批转入强制代理的 Brokered Browser Runtime。
53. 完成 **Brokered Browser Runtime Core 与 Host 控制传输边界**：新增 `@traceforge/browser-runtime`，Browser Process 必须由本机 Execution Node 以 sandboxed 且 OS `network=deny` 启动；调用者原 brokered 网络权限只保留在可信 Host。Controller 必须先证明 pipe、联网前暂停、Service Worker 禁用、下载和 WebSocket 拦截，验证后才能开始交付请求。navigation、redirect、popup、iframe、fetch/XHR 和 download 每次复检 Case/Run/Work/Worker/Scope/lease、重新授权并通过 `ExecutionNode.requestHttp`，重定向不自动跟随；WebSocket 在有界流式 Broker 完成前阻断。下载必须形成 Artifact，Session 失效/超额会冻结并终止进程，快照不保留正文或完整敏感 URL；重放、未知结果围栏和关闭失败后仍杀 OS 进程已有回归。Host 侧 `ExecutionNodeBrowserController` 进一步实现版本化有界长度帧、审核 Controller/Browser 版本与 SHA-256 对照、handshake-before-activation、稳定写操作 ID、并发容量、协议丢字节/截断/进程退出失败关闭及旧 generation 迟到响应隔离。3 文件/18 项短回归、16 packages/Server 编译和 294 源码边界检查通过。沙箱内 Chromium/CDP 适配器、真实浏览器/原生平台断网证明、DOM/截图及人工接管恢复仍未完成，Browser Provider 继续关闭；下一批整体完成这些底座能力，不接 Web Scenario。
54. 完成 **Browser Controller 进程协议与 Chromium CDP 策略适配**：进程侧 `BrowserControllerProcessRuntime` 与 Host Controller 使用同一版本化有界帧完成 ready/activate/request/result/shutdown，Host 请求超时、未知或损坏帧会关闭 CDP 并以失败码退出。`ChromiumCdpAdapter` 在激活前设置 Target auto-attach、`waitForDebuggerOnStart`、全局 deny download；每个 page/popup/iframe/worker 都在脚本释放前安装 HTTP(S) request-stage Fetch 拦截，Service Worker 在释放前关闭，未知 target detach。POST 优先保留 CDP 原始 base64 entries，正文不可取得即阻断；Host Broker 响应只能由 `Fetch.fulfillRequest` 注入，拒绝走 `BlockedByClient`，Chromium download 事件必须对应已形成 Artifact 的响应。普通 document 返回 attachment 也会自动保存 Artifact，解决 CDP 在请求阶段无法预知下载的问题。5 文件/27 项短回归、16 packages/Server 编译和 296 源码门禁通过。真实 Chromium FD pipe transport、浏览器子进程/发布装配、DOM/截图和人工接管恢复仍未完成，生产 Browser 继续关闭；下一批不接 Scenario。
55. 完成 **真实 Chromium pipe transport 与双材料发布身份/启动装配**：`ChromiumPipeTransport` 使用 Chromium `--remote-debugging-pipe` 的 FD 3/4 和 NUL 分帧，限制消息、缓冲、在途命令及启动/命令/退出时间；固定无后台网络、禁 Service Worker、独立 profile 等参数，只允许显示尺寸/语言/缩放参数和最小环境白名单，拒绝无沙箱、调试端口、代理、替换 profile 及未知环境。启动前核对浏览器文件 SHA-256，连接后再核对 `Browser.getVersion`；协议损坏、未知响应、超时、进程退出均失败关闭，退出卡死强杀且 stderr 原文不外泄。严格发布清单把 Controller bundle 和 Chromium 的文件名、版本、摘要、平台、架构钉在同一身份上，bootstrap 复核两个安装文件后固定装配 pipe、CDP Adapter 和进程 Runtime，没有非 pipe 的生产注入旁路。8 文件/37 项 Browser 短回归、16 packages/Server 编译和 299 源码门禁通过。真实 Controller bundle/Chromium 发行物、真实浏览器/原生断网验收、DOM/截图/控制和人工接管恢复仍未完成，生产 Browser 继续关闭；下一批仍只做底座，不接 Scenario。
56. 完成 **有界页面观察/控制、人工接管恢复与 Controller bundle 入口**：Controller 用 Accessibility Tree 生成省略表单 value 的有界 DOM Artifact，用视口/尺寸/像素/字节上限生成 PNG Screenshot，并记录与前一 DOM Artifact 的 added/removed/changed 摘要。元素引用同时绑定控制代次、page、document loader 和 backend node，且只有最近一次 DOM 观察实际签发的元素可操作；模型猜编号、导航后复用、接管后复用均拒绝。动作限定为绑定当前 view 的 navigation、已签发元素 click、editable-only fill 和固定键，不执行任意 JavaScript；Host 对 Controller 返回的 bytes/digest/MIME/schema/代次二次验真，正文写 Artifact 后只返回引用。人工通道以 takeover ID 区分，但继续复用同一观察/动作/授权/网络上限；接管和恢复各换代一次，Agent/人工旧引用全部失效，Snapshot 有界保留观察、动作来源/输入摘要及控制转换。严格 CLI/stdin/stdout 入口读取稳定、限长、严格 UTF-8 发布清单，可确定性构建为单文件 Node 22 ESM Controller bundle，禁止遗留相对/workspace 运行依赖。10 文件/48 项 Browser 短回归、64,196 字节 bundle 双构建一致性检查、16 packages/Server 编译和 302 源码门禁通过。本批没有运行真实 Chromium/原生平台联网、真实模型、超长全量或 Linux 真机测试；正式发行材料与真实浏览器验收未完成，生产 Browser 继续关闭，不接 Scenario。
57. 完成 **真实 Chromium 本机全链、崩溃回收与整树发行身份/原子装配**：macOS arm64 Chrome 152 通过真实 FD 3/4 pipe 跑通 navigation、302 redirect、popup、同进程 iframe、fetch/XHR、Artifact-backed download、DOM/截图/动作、人工接管恢复和 renderer crash 通知；同一验收还从 v2 manifest 启动可复现单文件 Controller，完成 stdio handshake/activate/request/observe/act/shutdown 并正常退出。测试页面全部由内存 Broker 注入，不访问外部目标。修复真实 Chrome 揭示的 iframe 分类和 shutdown stdin 悬挂。发布身份不再只哈希启动文件，而是度量完整安装树的内容、权限、目录和根内相对软链接；逃逸/绝对链接、特殊文件、容量超限、测量时变化、复制前后不一致或覆盖已有目标均失败关闭。12 文件/52 项短回归、1 文件/2 项真实 Chrome 集成、71,629 字节可复现 bundle、16 packages/Server 编译和 304 源码门禁通过。正式可再分发 Chromium 和 Linux/Windows 原生断网证明仍未完成，生产 Browser 继续关闭，不接应用或 Scenario。
58. 完成 **Chromium 来源锁、安全解压与 v3 本机安装门禁**：新增严格 `traceforge-browser-runtime-source-lock-v1`，固定来源身份、版本、revision、平台/架构、HTTPS URL、归档字节数/SHA-256、唯一根目录、相对启动文件及安全/许可证评审引用。发布装配不再接受任意已解压目录；同一只读归档句柄在解压前后验真，ZIP 流式解压限制条目、单文件与总展开量，拒绝加密项、路径穿越、重复路径、特殊文件、逃逸软链接及链接下内容，失败清除半成品且不覆盖已有目标。v3 release manifest 记录锁摘要与归档溯源，发布目录携带 `source-lock.json`；Controller CLI 启动时重新核对可信来源锁、溯源、平台/架构、完整树、启动文件和 Controller 后才打开 CDP。14 文件/56 项 Browser 短回归、1 文件/2 项真实 macOS Chrome 集成、78,996 字节可复现 bundle、16 packages/Server 编译和 306 源码门禁通过；完整 Foundation 矩阵另有 92 文件/1,465 项、8 文件/62 项及 15 文件/90 项全部通过。没有把开发机 Chrome 或 Chrome for Testing 直接认定为生产发行源，也没有修改应用或 Scenario；各平台正式材料审核和 Linux/Windows 原生断网证明仍是发布门槛。
59. 完成 **Browser 来源评审权威、撤销门禁与生产路线收敛**：新增严格 Source Review/Authority 合同，以离线 Ed25519 签名把精确 Source Lock 摘要绑定到 review key、允许的 source ID、签发/过期窗口和撤销时间；未知 key、跨来源越权、未来/过期评审、已撤销 Authority、非规范 Base64、错误签名或 Lock 换代全部 fail closed。v3 manifest 追加 Review key/摘要/到期身份，原子 release tree 携带 `source-review.json` 但不携带 Authority；Controller CLI 从 release tree 外部读取可信 Authority，每次启动重新验签后才检查安装树并打开 CDP。官方资料核对后明确：Chrome for Testing 仅用于可信内容自动化，Chromium 公开快照是 best-effort 且可能为任意 revision，自动更新 Chrome 和未经审核第三方包也不能满足固定生产身份；候选路线收敛为固定 Chromium 官方 commit、完整依赖/工具链后自建无品牌产物。15 文件/58 项 Browser 短回归、1 文件/2 项真实 macOS Chrome 集成、87,335 字节可复现 bundle 和 307 源码门禁通过。本批没有批准虚假的真实发行版本，也未修改应用或 Scenario。详见 [Browser Runtime 发行来源策略](architecture/browser-runtime-source-policy.md)。
60. 完成 **官方 Chromium 自构建证明与发布启动硬门禁**：新增严格 `traceforge-browser-runtime-build-attestation-v1`，只接受 Chromium 官方 Git 仓库和完整 40 位 commit，固定源码依赖清单、`depot_tools` commit、依赖解析、GN 参数、构建配方、目标归档/完整树、SPDX/CycloneDX SBOM、NOTICE、安全/许可证评估及平台签名身份。每个目标至少需要两个 builder、环境摘要和 provenance 摘要均不同的独立复现，且完整浏览器树必须完全一致；macOS/Windows 分别要求 Apple Developer ID/AuthentiCode 身份，Linux 不接受用两者冒充本机平台证明。Attestation 摘要进入 Source Lock 后再由离线 Source Review 签名，换工具链、评估、SBOM 或复现记录都会让原签名失效。原子发布携带 `build-attestation.json`，装配时实测树、启动时安装树都必须与证明树一致，CLI 对证明文件使用有界稳定读取。16 文件/61 项 Browser 短回归、1 文件/2 项真实 macOS Chrome 全链、98,215 字节可复现 Controller bundle、308 个生产源码边界及完整 Foundation 的 92 文件/1,465 项、8 文件/62 项、15 文件/90 项全部通过。本批没有执行或伪造大体积 Chromium 正式构建，没有启用生产 Browser，也未修改应用或 Scenario。

### 2026-09-02 排期决定：暂缓桌面软件更新系统

- 暂不开发桌面自动更新、下载管理、相邻旧版本保留、更新后首次启动确认或安装器级自动回退。
- 现有 helper 发布清单和运行时摘要校验继续保留，因为它们也用于确认当前本机安装材料没有缺失、错配或被替换，不依赖自动更新系统。
- `autoInstallOnAppQuit=false` 继续作为安全默认值，防止已下载内容在普通退出时静默切换；不据此宣称桌面更新闭环已经实现。
- 只有用户以后明确恢复桌面更新需求时，才重新规划安装器、平台签名、失败回退与撤销流程；当前不为它继续建设代码。

### 2026-09-02 产品范围决定：不提供远程 Execution Node

- 产品唯一执行主链固定为“本机应用 → 本机 Execution Node → 本机原生沙箱 → 安全工具”；本机 RPC 仍用于进程/权限边界，不等于远程服务器。
- Linux VPS 只用于验证 Linux namespace、cgroup、seccomp、AppArmor、崩溃清理和发布产物，不是安装、运行或授权 TraceForge 的依赖。
- 保留原生沙箱、本机 Execution Node、本机 RPC、PTY/signal/terminate/adopt，以及逐操作 ID/节点账本；这些能力对本机 IPC 断线、应用崩溃和副作用去重仍然必要。
- 已定向撤回仅服务远程部署的 TLS 双向认证、远程证书固定、Ed25519 远程节点世代证明、Host 侧远程派发围栏/管理路由及跨主机测试装配；引用和数据库建表已审计，新库不再创建远程表，旧库历史表不做破坏性删除。本机共用能力未回滚。
- 历史完成记录继续如实保留，不能把已经实现和验证过的远程代码改写成“从未存在”；但它不再计入当前产品完成度，也不进入后续发布门禁。

当前明确边界：Agent Journal 已与宿主存储解耦，但真实工具效果、pending receipt、pending Control command 和控制面提交仍必须留在可信 `WorkerHost`，因为它们依赖租约和执行权。Artifact/State 已是通用资料能力；生产 Scenario 工具正文已强制进入进程型 Package 和 OS-backed Execution Node，实际隔离强度仍取决于部署主机通过验收的原生后端。Package 授权、输出校验和证据映射已由固定解释器读取有界数据合同，生产默认不执行对应 Package 回调；官方 `scenario.json` 加载链可从签名材料构造冻结 Package，手工旧对象仍由受信宿主代码装配。macOS 测试启动器不能冒充 Windows 原生实机认证。

刚完成的里程碑：**本机执行底座生产闭环（仓库内部分）**。五类控制身份、Linux stdio/framed PTY、宿主/helper 异常清理、长期逐操作账本、归档中断恢复、容量健康、生命周期与发布门禁已经在同一轮完成并通过完整 Foundation 回归。当前不能在 macOS 伪造的两项仍如实保留为发布外部门槛：Ubuntu x64 重跑协议 2 的 19 类原生矩阵，以及 Windows restricted-token/AppContainer 的 stdio/ConPTY 双模式实机验收。它们不引入远程产品节点。

受控扩展装配与信任生命周期里程碑现已完成：统一静态/动态身份、MCP 精确 Package 绑定、运行期撤销、显式整代回退、Managed Provider 对账、Package Process 启动身份、Provider/Assembly 强杀恢复和 Assembly 有界压缩历史已形成同一闭环。

刚完成的新增底座边界包括：**生产 Scenario 工具执行强制进程化，以及授权/输出/证据合同声明式化**。签名审核后的 Package 也不能把工具工厂、Scope 解析器、资源授权器或输出映射回调直接放进 Server；正式工具只能走 Scenario Process，Host 内只解释有界数据。旧接口仅在测试/迁移显式开关下可用，并会在诊断中暴露。宽泛的统一 Extension Bundle 安装器因当前没有真实分发需求继续暂缓。

底座完成度审查与仓库收口已经完成，不再默认增加新的控制层。审查按实际代码核对 Scenario/Core 边界、Runtime/Model/Tool/Context/Execution/恢复主链、生产默认配置和文档声明，并修复签名数据包本地资源正文仍需宿主重复配置的问题；“仓库实现/外部平台验收/场景阶段”清单已经落档。

刚完成的整改里程碑：**三个 P0 安全/架构债一次性整改**。Desktop Main 已把现有随机内存 Host Capability 只注入当前本机 Server 的 API/WS；LLM 配置改为元数据文件 + 宿主 Secret Store，明文取回路由已删除，旧明文会迁移后从 JSON 消失；生产 `main.ts` 不再创建或连接旧 MCP Manager，旧配置只给出停用诊断；Web `0.1.0` 同进程工具、direct Browser 和相关生产依赖已删除，唯一生产身份为签名数据描述 + Scenario Process 的 `0.3.0`。详细实现和验证基线见 [TraceForge 继续开发前整改计划](remediation-plan-2026-09-03.md)。

刚完成的 Linux 部署里程碑：**安装链仓库实现闭环、实机发布证明待验收**。实际作用是 Linux 用户必须通过受支持 DEB 和本机 systemd/AppArmor 启动链才能获得进程沙箱；双击便携程序不会偷偷退回普通进程。当前没有 Linux 真机，所以系统级安装、升级回滚和协议 2/19 类矩阵保持未验收，不借用远程节点或模拟结果填满。

当前下一开发里程碑：**执行第一套真实 Chromium 自构建发行材料**。Build Attestation、Source Lock/Review、原子装配和启动硬门禁已经完成，不再继续增加空字段。下一整批应在有足够磁盘/内存的隔离构建环境固定一个官方 Chromium commit、`depot_tools`、依赖解析和 GN 配置，完成至少两次独立构建，产出真实 SBOM/NOTICE、安全/许可证评估、平台签名、归档和完整树摘要，再用现有门禁生成第一套非测试 Source Lock/Review/release tree。Linux/Windows 原生 `network=deny` 证明仍需对应真机可用后执行；当前不做应用 UI、桌面自动更新系统或 Scenario 适配。

实际作用：底座现在不仅强制检查“用户装的是不是批准的那份浏览器”，还会追问“它由哪份官方源码、哪套工具和参数制造，SBOM/NOTICE 与安全/许可证评估是什么，两次独立生产是否得到完全相同的文件树”。系统 Chrome 偷偷升级、安装包被换、少一个库文件、清单自带假公钥、旧批准过期、审批 key 被撤销，或者有人只替换 GN 参数/SBOM/评估记录，都会拒绝装配或启动。下一批的价值是把这套已经能验真的质检线喂入第一批真实工厂材料，而不是继续拿测试摘要证明自己。

里程碑完成标准不变：新扩展只靠声明的 Package/Skill/Knowledge/MCP/Provider 资源即可装配，不修改 Core 默认工具或场景常量；安装内容和运行内容可追溯到同一签名身份，撤销后新的模型上下文和工具调用立即停止使用，旧任务保留证据但不盲目重做；升级/崩溃/数据库重开不会留下半安装、半授权或被误释放的未知外部占用；完整 `verify:foundation` 与相关跨进程强杀门禁通过。真实模型与 24/72 小时长稳仍按用户要求暂缓，实机平台门槛另行执行。

通俗作用：现在底座已经有一块可信“总配电板”——某个 MCP 连接只给指定 Package 用，被撤销后会真的断电；Provider 安装、启用、排空、隔离或失败都会形成可追溯代次；进程实际采用的启动配置也钉在总图上。即使断电发生在 Provider 与总图切换之间，重启也会自动对齐；旧总图太多时会先封装成可校验压缩档案，再释放热记录，而不是直接删历史。

本批的实际作用：安全场景提供的工具代码现在不能再“坐进底座驾驶室”，即使它有签名也必须待在本机沙箱进程，只能通过受控窗口申请授权、写证据和读写自己的状态；它崩溃、卡死或被撤销时，不会直接带走 Server 进程。

本批的实际作用：以前场景即使工具在隔离进程里，仍能通过几段“规则函数”进入 Server；现在这些函数换成底座只读的标准表格。场景只能写允许哪些动作、资源从 Scope 哪个固定字段取得、输出多大、引用必须以什么开头、怎样用固定字段生成证据，不能在这些位置夹带任意 JavaScript。

本批的实际作用：现在已经把“开发者在宿主源码里手写并注册一个 Package 对象”改成“底座读取一份签名且只含数据的场景说明书”。以后新增代码审计、取证或红队场景时，不需要修改 Core 或编译场景装配回调；底座核对说明书、资源和程序文件完全匹配后，再把程序交给本机沙箱。

本批的实际作用：智能体现在不只会“对一个地址发一次请求”，而是能在授权范围里有秩序地认识一个站点：知道发现了哪些页面、每条观察来自哪次真实响应、还剩多少没覆盖；进程崩溃后也能从保存的队列继续，不会从头乱扫。

本批的实际作用：智能体现在能检查“登录后才能看到”的内网页面，但密码、Token、Cookie 不交给模型，也不会散落在普通日志里。会话被撤销或任务失去执行权时会立即冻结，同时能追溯某条流量使用了哪个受控身份。

本批整改的实际作用：Web 场景程序现在由可审查的 TypeScript 模块稳定生成，签名时不会漏掉它依赖的运行文件；底座组装模型上下文时也统一走同一套血缘过滤，Planner 和 Observer 不会各自漏掉已失效或受污染的来源。

本批整改的实际作用：Planner、Observer 和 Worker 现在都是可以脱离 Server 使用的“思考发动机”，但真正执行网络、文件、进程和工具的钥匙仍握在受控宿主手里。换成 CLI 或另一种本机存储时，不需要复制三套模型逻辑，也不会因为代码下沉让模型直接获得执行权。

本批整改的实际作用：已经从 Fake CDP 走到真实 Chrome，并把“主程序哈希没变就算可信”升级为“从审核来源压缩包到完整安装树再到每次启动，任何一环对不上都失信”。下一批固定真正随产品交付的 Chromium 发行方和真实材料；发行审核或原生沙箱若不能证明合规且全部流量被拦住，生产能力仍保持关闭。
跨角色结构化 lineage、有界压缩生命周期及压缩事实协议已实现，但任意文本污染追踪、真实语义质量与全部事件历史冷热归档/扩容未完成。
用户取消信号与 Discovery/RPC 截止已接线，本机原生进程的强制停止与可信清理仍须继续扩大平台实机证明；
永久键/上下文规模扩展、桌面本机受信宿主桥接、混合资产包迁移及签名轮换仍为显式缺口。签名数据化 Scenario Package 加载已完成；生产 Scenario 工具工厂与授权/输出回调已禁止同进程执行。远程管理与多活/多节点配额已排除出产品范围，不再列作缺口。

独立平台发布门槛仍是 Windows 双模式实机验收，以及原生可信报告签发/独立通道与 profile 残留恢复；需要真实 Windows 主机，
不能用当前 macOS 的 Node 子进程测试或源码交叉检查替代。未满足时继续关闭默认原生信任，不影响本机继续推进通用可靠性工作。

真实文件系统耗尽/断电仍需独立隔离测试卷，不在开发机主卷造满盘；24/72 小时实际运行继续暂缓，未经用户重新要求不自动恢复。
永久键或冷库满额继续拒绝新增操作，不删账恢复运行。

通俗作用：现在规划、观察、执行都能追溯受控资料的来源，资料失效后会挡住相关旧摘要和旧指令；
长记录可以缩短叙述而保留任务、证据和审批的结构引用。摘录可能丢失语义，准确性仍待真实模型验收。
现在停止任务会传到执行链，卡住的发现/RPC 有明确等待上限；没法确认的外部动作仍留待核实，不自动重做。
现在可以用带归属的断点补读事件，从保存的来源补记控制/压缩/恢复事实，明确区分停止请求和清理证明；补记延迟会显示出来。
本轮已让默认受控 Provider 的未知外部占用继续算在账上，重启不把名额误当成全部空闲，核实清理后才释放；
没有可信证明时，正常结束也可能继续占名额，不隐瞒这项部署限制。不同界面和安全场景可以复用这些配额与审计事实。
本轮已能把匹配审核契约的技能/知识资源成组签名迁移，核对来源、内容和依赖，中途失败不留下半成品，导入不自动获得执行权限。
本轮已让内置进程、MCP Tools 和 MCP 资料读取与默认受控 Provider 共用名额，不能靠换这些入口绕过上限；
停止或重启都不误算空闲，服务发现保留真实宿主归属。未配置可信清理时，正常结束也可能占满后续名额，这项部署限制仍保留。
本轮已把核实完的清理证明和操作正文压缩归档，热库保留占用身份与防重复索引；查证时按原身份读回，搬运中断/档案损坏不能误放行。
它降低热正文压力，不代表永久键、SQLite 文件或总存储无限。
本轮已解决“宿主把裸 Execution Node 发给后装工具”的装配问题：需要进程的来源通过宿主发放的受控端口，
以后新增安全场景或插件时不会因为换一种宿主接入方式而无意绕过配额、取消和重启围栏；纯计算工具不占进程名额。
这不约束恶意同进程 JS 私自调用系统能力，因此仍只允许经过审核的本机工厂，不把声明当沙箱。
本轮已让“允许工具干活”不等于“允许它修改底座管理状态”：工具仅知道本机地址或任务身份，不能通过这些 HTTP 入口替你批准权限、
解除未知执行占用或恢复被暂停的任务。旧匿名客户端需要迁移到可信宿主通道，不是增加用户、登录或租户功能。
本批已解决兼容升级时如何保留旧任务：先检查、再授权、一次提交，失败保留原状态；迁移后仍暂停，旧证据/审批/检查点不抹掉。
它不支持任意改造任务结构，也不会自动重做旧动作。
本批已固定旧授权所依据的包版本；安装新版不会自动放宽或收紧旧授权，历史缺版本记录须明确确认，兼容升级不改原范围。
本批让“同样写着 1.0 版”不再足以放行：审核文件被替换、丢失或撤销会阻止后续受控使用；文件和内存对象的对应仍须可信宿主确认，不等于系统沙箱。
本批解决“包已经不可信，但旧任务不能只剩一个报错”：仍能查看它做过什么、安全叫停并核实哪些外部动作尚未结束，保留证据与历史，不误当成已经清理干净。
本批解决“任务跑得越久，重启和查历史越吃力”的一部分：旧事件可分段保存，用可核验状态快照接上尾部；查证仍按原顺序找回事实，不靠模型摘要猜进度，不重复执行旧动作。压缩档案仍需校验，因此不是恒定时间恢复。
此前“电脑或数据库出了问题，能不能把工作找回来”的灾难恢复批次已经完成仓库实现：备份在隔离位置校验恢复，未核实的外部动作继续保留未知围栏，不因恢复旧备份而自动重做。当前下一里程碑以本节上方的受控扩展装配与信任生命周期为准。
单用户前提保持不变：不开发账号/租户系统。管理端口只需与模型和工具进程隔离，actor 继续作为本人操作的审计说明。
以后换安全场景仍然是换技能、资料和工具包，不把场景写死进底座。等用户提供配置后，再检查真实模型是否能读懂任务和工具结果。
现有离线回归只证明预设输入下的运行机制；暂缓联调不等于真实模型已验收，跳过长跑也不等于连续多日稳定性已验收。
通用底座继续冻结；具体场景只通过审核 Package 边界推进。
