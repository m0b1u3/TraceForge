# TraceForge 当前开发进度与生产化计划

更新日期：2026-08-29

## 1. 项目目标

TraceForge 的目标不是通用编程 Agent，也不是某个漏洞扫描器，而是一套独立运行的通用安全智能体底座。底座负责认知调度、黑板协作、证据生命周期、上下文治理、工具运行、安全执行和人工审批；Web 黑盒、白盒审计、红队横向等能力通过 Scenario Profile、Worker 能力和受控工具 Provider 装配。

目标协同结构不是固定两个 Agent。Planner 和 Observer 是常驻的认知与仲裁角色，执行侧按照 Scenario Profile 和任务压力动态创建 Research、Validation、Review、Report 等 Worker。所有角色通过持久化 Run Event、Work Package 和 Evidence Graph 协作，不通过共享自然语言聊天记录协作。

## 2. 进度口径

本文中的“已落地”表示代码、类型、持久化模型和自动化测试已经存在，不代表已经完成真实环境长期运行验收。“生产可用”还要求安装升级、故障恢复、性能容量、安全边界、操作界面和真实授权环境评测全部通过。

当前工程估算如下：

| 范围 | 完成度估算 | 说明 |
| --- | ---: | --- |
| 通用安全智能体底座 | 约 90% | 调度、证据、执行与 Provider 主链已经成型；Provider 恢复、Discovery 历史状态和默认生产接线已落地，Scenario Runtime 与 Tool Runtime 后续故障治理仍待完善 |
| 单机生产化能力 | 约 71% | 已具备持久化、门禁、Execution Node、原子 Provider 安装、调用感知升级、Discovery 重启安全恢复、所有权感知垃圾回收及受控签名归档分发链；Provider 刷新和长稳测试未完成 |
| Web 黑盒实战场景 | 约 35% | HTTP、会话、授权、流量和证据工具已接入；受控浏览器和完整探索/验证策略仍未闭环 |
| 白盒代码审计场景 | 尚未正式开发 | 只复用底座，不在当前开发主线上加入 AST、污点规则等场景工具 |
| 红队内网横向场景 | 尚未正式开发 | PTY、隧道、长期远程会话和高风险审批策略仍待后续装配 |

这些百分比是按目标能力和生产验收项估算，不是按代码行数或测试覆盖率计算。

当前最准确的产品定位是：TraceForge 已经是一套可运行、可持久化、可恢复、具备安全执行主链的
Security Agent Runtime，并进入底座生产化阶段；但它仍是以 Web 黑盒作为首个纵向场景演进出来的
Web-aware Runtime，尚未达到“Core 完全不知道任何 Application/Scenario 语义”的目标状态。

关键能力的实际状态如下：

| 能力 | 当前状态 |
| --- | --- |
| Event-sourced Run、Work/Lease/Checkpoint/Recovery | 已实现 |
| Planner、Observer、Worker Loop | 已实现 |
| Evidence Graph、Finding 生命周期门禁 | 已实现 |
| Cognitive Snapshot、Model Runtime、预算与并发准入 | 已实现 |
| Capability Registry、Tool Discovery、Risk/Permission Gateway | 已实现 |
| Managed Provider、签名/哈希、generation draining | 生产主链已实现 |
| Execution Node RPC、Scope 再授权、Brokered HTTP | 主链已实现 |
| Windows 可证明执行约束 | 主链已实现 |
| Scenario 插件化、零场景运行 | 部分实现：独立 SDK、空 Registry、Web 物理迁移、Run 版本固定、输出校验/证据映射、资源/migration manifest Contract 和独立底座门禁已完成；显式包迁移命令尚未完成 |
| Provider-to-Host 反向能力 Broker | 底座主链已实现：Core、双向 RPC、持久化授权、可选 Host Registry 和中性真实子进程验收通过；具体能力 Adapter 冻结到场景阶段 |
| Tool Provider 恢复与隔离 | 进行中：恢复、Discovery、quarantine 对账、重复重启验收、日志隔离与保留治理、公平调度、升级审计、调用 Contract Binding、原子准入围栏、终态对账、所有权感知垃圾回收及受授权的确定性签名归档导入已实现；显式刷新尚未完成 |
| Linux 可证明沙箱后端 | 未实现，保持关闭 |
| Brokered Browser、多节点执行、统一运维控制台 | 未实现 |

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
- `web_blackbox` Definition、能力、阶段、Worker 拓扑、授权策略和执行工具已经移入
  `scenarios/web-blackbox`。独立 `scenario-sdk` 只暴露 Package、Authorization、Session、Traffic 和宿主装配端口；
  Core 与通用 Foundation、Routes、Embedded Worker、Authorization/Traffic SQLite Adapter 和 Execution Node Service
  不再 import Web，只有产品入口显式选择安装 Web 包。

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

### 4.1 Scenario 尚未从 Core 和 Composition Root 真正抽离

第一段抽离已经完成：`orchestration-core` 不再声明具体 Scenario/Work/Role/Output 枚举，也不再包含或导出
Web Definition；Scenario Definition Registry 可以为空，路由 Definition Catalog 在未安装场景时返回空列表，
Server Foundation 接受外部 Definition 清单，产品入口显式安装 Web Definition。

第二段抽离也已完成：Foundation 接受显式 `ScenarioPackageInstallation`，Package Registry 汇总 Definition、
Authorization Policy 和 Tool Discovery Source；通用 Embedded Worker 只装配 Knowledge/Execution 平台工具和外部
传入的场景来源，不再 import 或默认构造 Web 工具。空 Package Registry 不产生任何场景 Definition 或场景工具。

第三段授权边界也已完成：通用 `ScenarioAuthorizationPort` 负责按 Envelope 归属加载授权，Package Policy
负责解析不透明 Scope、动作集合和具体资源；Execution Node 只提交 `resourceKind + value`，不再直接认识 URL、
Web Guard 或 Web 黑盒。中性 Scope/资源测试证明该服务可以处理非 URL 资源。

第四段物理边界已经完成：`ScenarioPackageInstallation/Registry`、授权/会话/流量端口进入独立
`@traceforge/scenario-sdk`；Web HTTP/Traffic/Session/Browser 工具和安装清单进入 Web 包；Server 只保留
SQLite 授权、会话和流量 Adapter 以及产品装配。Scenario 包不再 import Server 类型或直接访问 SQLite。

第五段版本绑定已经完成：新 Run 在事件事实和 SQLite 投影中同时持久化 Package id/version/schema revision；
Runtime、Routes 和 Embedded Worker 在加载或执行前验证准确绑定。缺包、Schema revision 不匹配或历史 Run
缺少绑定时返回 `recovery_required` 诊断，不会静默套用当前安装版本；旧数据库只增加 nullable 字段，不伪造绑定。

第六段输出与证据边界已经完成：Package 注册版本化 Output Schema，Registry 在安装时确认 Definition 引用的
输出类型都有 Schema；生产完成路径在写入 Run Event 前由当前绑定包校验，Event 持久化 schema version，随后通过
通用 `ScenarioEvidencePort` 幂等映射到 Evidence Graph。Web 的输出类型和映射规则只存在于 Web 包，Server 只提供
Evidence Graph Adapter，Core 仍只处理通用 Output Envelope。

尚未完成的是具体场景资源装配与生命周期控制：通用 Package 已能声明和校验 Prompt、知识与 migration
资源，但具体内容仍冻结，显式包迁移/排空命令也尚未实现。新增取证、恶意代码分析、
云安全或移动审计可能需要新的通用宿主能力端口，但不再需要修改 Core、通用 Foundation、通用 Routes、
Embedded Worker 默认工具数组或 Execution Node Service。

在完成抽离前，TraceForge 只能称为“具备通用运行机制的 Web-aware 应用底座”，不能宣称 Scenario
已经插件化。不得继续向 Core、通用 Server 或默认 builtin tool source 增加任何场景名称、能力、阶段、
角色、输出类型、Prompt、工具或授权动作。

### 4.2 Tool Provider 控制面仍需完成生产化后半段

签名 Manifest、信任根、文件/包哈希、只读原子目录发布、持久化生命周期、控制 API、显式回滚、
启动恢复和按调用归属的生产托管来源工厂已经落地。调用级 Contract Binding、原子 Admission Fence、
通用 Work/Run 终态释放、Provider 日志审计隔离与 detail 保留/授权查询治理、公平配额和升级兼容治理也已完成。
安装包和调用暂存目录的所有权感知垃圾回收也已落地。确定性 `.tfpa` 归档、安全解包库、离线签名发布命令及
受授权的流式上传/安装 API 已经完成；尚缺显式刷新 API 和整链故障注入验收。

### 4.3 Provider 反向能力 Broker 已完成底座主链，具体 Adapter 尚未开发

Provider 进程现在必须使用固定的最小 OS 权限。通用 Broker Core、双向 RPC、持久化 Receipt、授权组合和
可选 Host Registry 已实现；零 Handler/Policy 时 Host 不创建，反向方法不对 Provider 开放。中性真实 Provider
子进程已经穿过 Managed Provider Source、Execution Node、Host Registry、授权和 SQLite Receipt，并验证重启
replay 与关闭后的迟到响应隔离。当前没有注册任何 HTTP、文件、浏览器或秘密句柄等具体能力；这些 Adapter
必须在底座验收通过后的场景阶段装配。

### 4.4 Web Browser 尚未进入可用执行链

原生 HTTP 已经走 Broker，但 Browser Worker 目前仍因缺少强制代理后端而关闭。需要完成浏览器进程沙箱、CDP 控制通道、所有页面/弹窗/下载/Service Worker 流量强制代理、人工接管和会话恢复，才能禁止直连的同时投入黑盒场景。

### 4.5 Web 黑盒的场景认知策略还不完整

当前底座能调度 Research 与 Validation Work，但还缺少生产级的资产面建模、页面状态覆盖、身份矩阵、业务流程状态机、参数与数据关系学习、验证矩阵、受控外带回调和最终覆盖评估。具体 Payload 和漏洞知识应放入 Web Scenario 工具/知识包，不进入通用底座。

### 4.6 运维与可靠性仍需补齐

- 工具、Worker、Planner、Observer、模型预算和执行节点虽有 API/事件，但缺少统一运维控制台。
- 缺少长时间运行、断电恢复、磁盘耗尽、Provider 频繁崩溃、模型供应商波动和高并发任务的系统级验证。
- 当前以 SQLite 单机模式为主，尚未给出多节点 Worker 的生产部署、队列和数据库拓扑。
- Linux 进程执行因缺少可证明的托管 cgroup 后端保持关闭。
- 凭据实体可以进入受权限控制的黑板，但面向操作者的查看、脱敏、授权与审计体验还未完成闭环。

### 4.7 `apps/server` 同时承担 API、组合根和大量 Runtime 实现

当前 `apps/server` 不只是 Fastify Adapter：Planner/Observer、Hypothesis 与 Artifact 调度、认知上下文、
Model Runtime/Admission、Evidence Store、Execution Session 和 Provider Control Plane 的大量实现都位于其中；
而 `packages/reasoning-core` 相对较薄。这会迫使未来 Desktop、CLI 或分布式 Coordinator 依赖 Server 内部代码，
也让 Application、Runtime、Persistence Adapter 与 Transport 边界难以验证。

这一问题不能通过按文件数量机械拆包解决。应先完成 Scenario Contract 和依赖方向，再按稳定职责逐步提取
可独立测试的 Runtime；Fastify 路由、WebSocket、配置加载、SQLite 适配和 Composition Root 留在 Server，
领域状态机与不依赖传输/数据库实现的 Runtime 移入 packages。

## 5. 接下来的开发计划

以下顺序按生产依赖关系排列，不是原型阶段划分。

### 当前开发边界：先完成底座，冻结应用与具体场景

从当前周期开始，开发严格分为两个阶段。底座验收完成前，只允许修改通用 Contract、Runtime、Provider/Tool
执行基础设施、恢复与隔离、安全后端、持久化、控制面 API 和底座测试门禁；`apps/web`、Web 黑盒策略、
Brokered Browser 的场景接线、Web 专属 Prompt/知识库、其他具体 Scenario Package 以及运维界面均冻结。
期间可以为了证明底座可扩展而使用中性 fixture 或最小测试宿主，但不能借测试宿主继续实现某个应用场景。

冻结不等于删除现有应用或场景代码。现有实现只接受阻断底座验收的兼容性修复，且修复不得新增场景语义、
工具策略或 UI 功能。所有新能力必须先证明属于多个场景共同需要的底座职责；无法证明时留到第二阶段。

当前实际执行队列：

1. ~~完成零场景底座构建/测试门禁、开放标识符校验和中性 Scenario Contract fixture。~~ 已完成。
2. ~~依赖图、Model Runtime、workspace 循环拆除以及 Cognitive 上下文/快照/评估/唤醒/循环调度提取。~~ 已完成。
3. ~~Provider-to-Host Capability Broker。~~ 底座主链与中性生产组合验收已完成。
4. **进行中：**Tool Runtime 的恢复、隔离和故障治理。
5. Provider 归档分发、签名工具、持久化调用回执与旧包回收。
6. Linux 可证明执行后端。
7. 完成底座重启恢复、故障注入、长稳、容量、安全基线和通用控制面 API 验收。
8. 通过“底座完成门禁”后，另开阶段开发 Web 黑盒、Browser、其他 Scenario 和应用界面。

同一优先级内只允许并行处理依赖方向已经稳定、不会扩大场景耦合的工作；不得以“并行开发”为由
绕过底座冻结边界。当前不以任何具体场景的端到端效果作为底座代码的设计输入。

### P0：Scenario Extraction 与通用运行时边界

当前状态：六段纵向改造已完成。Core 已能在不知道 Web 名称和 `validation` 语义的情况下注册、启动、
调度和恢复；Web Definition 已成为独立 workspace 包；Foundation、Routes 和 Embedded Worker 通过显式
Package Registry 装配，零 Package 时不注册场景 Definition 或场景工具；Execution Node Authorization 已通过
通用资源授权端口解耦；Scenario Contract 已提取为独立 SDK，Web 工具不再依赖 Server/SQLite；Run 已固定绑定
Package id/version/schema revision；版本化 Output Schema 和通用 Evidence Port 已接入生产完成路径。
Prompt/知识资源引用与 migration manifest 的通用 Contract 已完成；具体场景资源装配和显式包迁移/排空命令仍未完成。

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
的通用 Contract 已由中性 fixture 验证；显式迁移/排空命令尚未完成。本阶段没有补写 Web 专属内容。

阶段 C：抽离 Web 黑盒包

- 新建独立 `scenarios/web-blackbox` workspace package，将 Web Definition、能力、Worker 拓扑、阶段、
  授权 Guard、HTTP/Traffic/Session/Browser 工具、输出 Schema、策略和测试移入该包。
- 删除 `orchestration-core` 对 Web Definition/常量的导出，删除 Embedded Worker 对 Web Profile 和 Web 工具的直接引用。
- Web 包通过通用 Contract 显式注册；只有配置安装并启用该包时，Registry 才出现 `web_blackbox@版本`，
  Tool Runtime 才出现 `web.*` 能力，相应 Worker Pool 才能创建。
- 保持现有 Run/Event/Evidence 数据可读；迁移只转换标识符和注册归属，不伪造生命周期事件或执行回执。
- Scenario Package 与 Tool Provider 是两个独立概念：前者定义调查语义、策略和装配，后者提供受控执行能力；
  Web 包可以声明所需 Provider capability，但不得绕过 Tool Runtime、Provider 签名或权限门禁直接启动工具。

进度：Definition、能力常量、阶段、Worker 拓扑、Authorization Scope/Resource Policy、HTTP/Traffic/Session/Browser
工具、场景回归测试和显式 Tool Source 安装均已迁移/接线；Web 包生产代码不再 import Server 或 SQLite。
输出 Schema 已迁移；Prompt、知识资源和场景 migration manifest 尚未迁移，因此 Web Package 仍未完成全部职责。
这些 Web 专属迁移在底座验收前冻结；底座阶段只允许用中性 fixture 验证对应 Package Contract。

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

当前状态：包级安装和生产启动纵切片已完成。签名清单、文件/包哈希、信任根、只读原子发布、
生命周期事件/投影、控制 API、隐式降级拒绝、显式回滚、启动恢复和按调用归属的 Execution Node
启动、调用感知排空切换和中断生命周期对账已具备；以下仍需完成分发工具与持久化调用回执恢复。

开发内容：

- 已完成 Manifest Schema、Event Store/查询投影、本地信任根、签名与哈希验证、生命周期 API、
  隐式降级拒绝、显式回滚、enabled 版本启动恢复、包级原子发布、生产来源工厂、generation 在途调用追踪、
  原子 `enabled`/`draining` 切换、排空后关闭和重启对账。
- 待完成归档上传/安全解包、签名发布工具、刷新 API、未完成调用的持久化回执对账和旧包回收。

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
Gateway 超时通过仅限 Host 本地、RPC 不序列化的 AbortSignal 取消排队或关闭在途的每调用 Provider 进程；名额只在
底层进程真正结束后释放，避免超时调用在后台继续运行却被错误地重复计容。调度拒绝和取消被标记为 Recovery 中性，
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

开发内容：

- Provider 进程采用指数退避、抖动、失败预算和 quarantine，避免崩溃重启风暴。
- ~~持久化发现 revision、最后成功目录、最新健康结果和有界故障原因。~~ 已完成。
- ~~将 Provider 日志与模型上下文彻底分离，只保留有界诊断和审计引用。~~ 已完成。
- ~~增加按 Provider、工具、Run 和 Work 的并发配额与公平调度。~~ 已完成。
- ~~建立 Provider 升级兼容检查、调用级版本固定、原子准入围栏和工具 Schema 差异审计。~~ 已完成。
- ~~建立确定性签名归档、离线发布命令和受限 staging 安全解包。~~ 已完成。
- ~~将归档导入接入鉴权控制面、安装审计和 staging 清理，并关闭默认本地目录安装旁路。~~ 已完成。
- 提供受授权、可审计、失败保留旧目录的显式 Provider 刷新 API。

验收条件：连续崩溃不会拖垮主进程；坏版本自动隔离；健康 Provider 和正在运行的 Work 不受无关来源故障影响。

### P1：Linux 可证明执行后端

当前状态：Linux 进程执行在缺少可验证后端时保持关闭。Provider、代码审计和大量安全工具不能以普通
`child_process.spawn()` 作为生产回退，因此这一项是实际安全场景扩展的基础设施前置条件。

开发内容：

- 建立独立 Linux native helper 与能力探测，明确内核、cgroup v2、namespace、seccomp/Landlock 等可用约束，
  不把“命令成功启动”等同于“策略已执行”。
- 对 CPU、内存、进程数、写入字节、文件系统可见范围和网络模式生成可验证 attestation，并与请求指纹绑定。
- 使用独立 user/pid/mount/network namespace、受控工作目录和最小 capability；不允许继承宿主敏感环境变量或凭据。
- 定义 rootless 与受管 helper 两种部署能力边界；缺少某项强制属性时按能力关闭，而不是降级为弱沙箱。
- 增加逃逸、资源耗尽、孤儿进程、租约过期、helper 崩溃、主机重启和不受支持内核的集成测试。

验收条件：Linux 后端只能在所有声明约束均有可验证证明时返回成功；Provider 和工具无法绕过网络、
文件系统或资源策略；不满足生产策略的主机明确报告 unavailable，且不存在直接 spawn 回退。

### P1：将 Runtime 从 `apps/server` 提取为可复用 packages

当前状态：已开始逐片提取。实际依赖图记录在 `docs/architecture/runtime-dependency-map.md`；当前 Server 有
102 个非测试生产文件，其中 17 个直接依赖 Fastify、50 个直接依赖 SQLite/Drizzle 或数据库模块。
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
不再各自维护定时器状态机。Run 枚举、评估、Prompt、决策 Schema 与应用策略仍留在调用方。

阶段 C：多宿主验收

- 建立不依赖 Fastify 的 Runtime integration harness，证明 Run、Planner/Observer、Worker 和 Tool Gateway 可直接组合。
- 增加最小 CLI/测试宿主，只依赖 packages 和端口实现，不 import `apps/server/src/*`。
- 增加 package dependency-boundary 测试和循环依赖检查，禁止 Runtime 反向依赖 Server、Desktop 或 Scenario 实现包。

进度：Model Runtime 的内存 Store/Provider harness 不依赖 Fastify、SQLite、LLM 实现或 Scenario Package，已验证
优先级、Run 级并发、Provider 回退、熔断、预算和超时；原 SQLite 集成测试继续覆盖记录、事件顺序、取消和
重启中断恢复语义。Cognitive Runtime 的无 Server harness 验证上下文裁剪、遗漏统计、语义指纹稳定性、预算拒绝、
快照幂等冲突、终态保护、重启中断、replay 成败审计、模型/解析错误的统一失败落档、Blackboard listener
故障隔离、consumer/run 级语义游标去重，以及 wake 风暴合并、无重叠 tick、停止排空和失败退避。
底座边界扫描自动覆盖新 package，并会构建 workspace 依赖图拒绝任何 package 循环。

验收条件：Server 仅承担 Adapter 与 Composition 职责；核心 Runtime 可在测试宿主或未来 CLI/Coordinator 中
复用；删除 Fastify 路由不影响 Runtime 包构建；包拆分不改变 Run/Event/Evidence 的持久化语义和重放摘要。

合并门禁：

- 每次只迁移一个有清晰端口的 Runtime slice，并保持公开行为、事件 schema 和测试基线不变。
- 新 package 必须至少有两个消费者或一个明确的非 Server integration harness；否则先保留模块边界，不创建空壳包。
- 禁止 Runtime package import `apps/*`，禁止 package 之间形成环，禁止为了消除类型错误复制领域模型。
- SQLite 查询与 Fastify request/reply 类型不得泄漏到 Runtime public API；Adapter 负责转换。
- 提取完成后删除 Server 中的旧实现，不长期保留双写、双运行时或兼容代理层。

### P1（底座验收前冻结）：Web 黑盒包内的 Brokered Browser Execution

开发内容：

- 通过 Execution Node 启动浏览器进程并验证沙箱证明。
- 建立强制 HTTP/SOCKS 代理后端，覆盖导航、重定向、弹窗、iframe、下载、WebSocket 和 Service Worker。
- 浏览器 Session 与 Identity/Vault、Cookie、Traffic、Evidence Graph 和租约绑定。
- 支持 DOM 快照、稳定元素引用、页面差异蒸馏、截图 Artifact 和人工接管后恢复。
- 不引入 Burp 依赖，也不提供直连回退。

验收条件：浏览器无法绕过授权代理；身份撤销或租约过期立即冻结会话；人工接管后 Worker 能从持久化状态继续。

### P1（底座验收前冻结）：Web 黑盒 Scenario Package 闭环

开发内容：

- 建立授权资产、端点、参数、身份、页面状态和业务流程图谱。
- Research Worker 生成互相独立的 Hypothesis 与后续 Work，避免单一路径占满预算。
- Validation Worker 采用基线、变量控制、重复验证、反事实和影响确认形成因果证据链。
- 增加身份/权限矩阵、工作流状态覆盖、错误与差异聚类、受控回调服务和覆盖缺口评估。
- Report Worker 只从 verified Finding 和完整 Evidence Chain 生成结果。
- 漏洞知识、测试模板和 Payload 作为可版本化 Web 工具包管理，不写入底座调度器。

验收条件：在多个授权测试应用上完成无人值守探索、人工门禁、因果验证、失败回溯和可复现报告；不能把扫描器单一命中直接升级为漏洞。

### P1（底座验收前冻结）：统一运维控制台

开发内容：

- 展示 Planner、Observer、动态 Worker、Work 租约、Evidence Graph、模型预算、Provider、Execution Node 和审批状态。
- 支持 Provider 排空/禁用、Work 取消/重试、Run 暂停/恢复、审批处理和证据回溯。
- 凭据面向有权限操作者可查看和使用，同时提供字段级权限、显式审计和安全展示策略。
- 所有界面操作调用控制面 API，不直接修改数据库投影。

验收条件：操作者能够从一个界面解释“当前为什么执行这个动作、用了什么权限、产生了什么证据、谁批准了什么”。

### P2：长稳、发布与多节点准备

开发内容：

- 建立 24/72 小时 soak test、故障注入、重启恢复和磁盘/内存/模型故障测试。
- 完成 Windows 桌面发布包、原生 helper 和 Provider 包的签名、升级及回滚验证。
- 定义 SQLite 单机容量边界，并为 PostgreSQL、持久化队列和远程 Execution Node 抽象迁移接口。
- 建立场景级评测集：探索覆盖率、无效动作率、循环率、验证准确率、证据完整率、人工介入率和单位发现成本。

验收条件：发布包在干净 Windows 环境独立安装运行；升级和崩溃不破坏 Run、Evidence、Approval 和 Provider 状态；关键指标具备稳定基线。

### 后续独立 Scenario Packages（底座验收后解锁）

底座完成门禁通过后，各场景按独立包推进，不再通过修改 Core 增加场景：

- 白盒代码审计 Profile：仓库快照、增量 Diff、AST/语义索引、Source-Sink 数据流、验证与修复证据。
- 红队横向 Profile：PTY、远程 Session、跳板与隧道、凭据实体、网络拓扑以及更严格的审批策略。

这些场景不会复制底座，只通过 `ScenarioPackage` Contract 注册自己的 Profile、Worker 策略、
授权策略、输出 Schema、图谱映射和工具 Provider。底座验收前不得提前开发任一场景的端到端能力；
验收后 Web 黑盒与其他场景可以独立排期，彼此不构成代码依赖。

## 6. 当前质量基线

- 全工作区构建通过。
- `test:fast`：176 个测试文件、691 项测试通过。
- `verify:foundation`：检查 221 个通用生产源码文件；14 个通用 packages 与通用 Server 独立编译通过；
  33 个测试文件、149 项 Runtime/Scenario Contract/Core/Broker/Discovery/Recovery/Diagnostic/Retention/Scheduling/Compatibility/Binding/Fence/GC/Archive/Import 边界测试通过，且不构建 `apps/web` 或 Web Scenario Package。
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
- Scenario Extraction 新增测试覆盖 Core 具体场景 import/身份禁入、开放 Scenario/Work/Role/Output 身份、
  空 Definition Registry/空 Catalog、Definition policy 验证、零包无场景工具、显式 Web 包工具注册、
  通用 Server 模块防回退、中性 Scope/资源授权、SDK 宿主端口、SQLite Traffic/Session Adapter 及独立 Web
  场景工具回归；Package binding 测试覆盖精确版本恢复、Schema mismatch、缺包诊断和旧数据库不伪造绑定；
  Output Schema/Evidence 测试覆盖缺失 Schema 拒绝、schema version 持久化和 Web 输出到通用图节点的幂等映射。

## 7. 最近的明确开发目标

下一项继续只做底座：提供显式 Provider 刷新控制。刷新请求必须经过独立授权和持久化命令审计，只允许定位到已安装且当前
可服务的精确 source/version；同一来源刷新串行化，并复用 Discovery Runtime 已有单航班机制。成功时记录刷新前后目录 revision、
工具目录指纹和健康状态；发现失败、身份漂移、工具越权或目录不兼容时保留最后一次成功目录，不影响正在执行的调用，并把失败
交给既有 Recovery/Diagnostic/Quarantine 链处理。相同命令重放必须返回同一审计结果，不得再次触发 Provider 调用。

通俗作用是：工具进程可能在不重装、不重启主程序的情况下更新“我现在有哪些能力”的目录。下一步会增加一个受控的“重新盘点”
按钮；盘点成功才换新清单，盘点失败继续使用上次确认过的清单，正在工作的任务不会突然找不到工具，同时能查清是谁、何时、为何
触发了刷新以及结果如何。完成后再做归档分发、升级、刷新、崩溃和磁盘故障的整链注入验收。仍不注册 HTTP、Browser、文件或
其他具体能力，也不修改应用层；每个代码改动仍须同步本路线图。
