# TraceForge 当前开发进度与生产化计划

更新日期：2026-08-28

## 1. 项目目标

TraceForge 的目标不是通用编程 Agent，也不是某个漏洞扫描器，而是一套独立运行的通用安全智能体底座。底座负责认知调度、黑板协作、证据生命周期、上下文治理、工具运行、安全执行和人工审批；Web 黑盒、白盒审计、红队横向等能力通过 Scenario Profile、Worker 能力和受控工具 Provider 装配。

目标协同结构不是固定两个 Agent。Planner 和 Observer 是常驻的认知与仲裁角色，执行侧按照 Scenario Profile 和任务压力动态创建 Research、Validation、Review、Report 等 Worker。所有角色通过持久化 Run Event、Work Package 和 Evidence Graph 协作，不通过共享自然语言聊天记录协作。

## 2. 进度口径

本文中的“已落地”表示代码、类型、持久化模型和自动化测试已经存在，不代表已经完成真实环境长期运行验收。“生产可用”还要求安装升级、故障恢复、性能容量、安全边界、操作界面和真实授权环境评测全部通过。

当前工程估算如下：

| 范围 | 完成度估算 | 说明 |
| --- | ---: | --- |
| 通用安全智能体底座 | 约 68% | 调度、证据、执行与 Provider 主链已经成型，但 Scenario 仍侵入 Core、类型系统和组合根，必须先完成场景抽离 |
| 单机生产化能力 | 约 63% | 已具备持久化、门禁、Execution Node、原子 Provider 安装和调用感知升级，但分发、垃圾回收和长稳测试未完成 |
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
| Scenario 插件化、零场景运行 | 未实现 |
| Provider-to-Host 反向能力 Broker | 未实现 |
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
- 上述运行机制本身大体数据驱动，但当前 `web_blackbox` Definition、部分场景类型、Worker 装配和授权工具
  仍被编译进 `orchestration-core` 与 Server Composition Root；因此“Scenario 已完全解耦”尚不成立。

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

当前 Web 黑盒不只是一个可选 Profile：`ScenarioKind`、部分 Work/Role/Output 类型、
`orchestration-core` 中的 Web Definition、Embedded Worker 拓扑、授权 Guard 和 Server 内置工具
都认识具体场景。这会导致新增取证、恶意代码分析、云安全或移动审计时必须修改并重新编译 Core。

在完成抽离前，TraceForge 只能称为“具备通用运行机制的 Web-aware 应用底座”，不能宣称 Scenario
已经插件化。不得继续向 Core、通用 Server 或默认 builtin tool source 增加任何场景名称、能力、阶段、
角色、输出类型、Prompt、工具或授权动作。

### 4.2 Tool Provider 控制面仍需完成生产化后半段

签名 Manifest、信任根、文件/包哈希、只读原子目录发布、持久化生命周期、控制 API、显式回滚、
启动恢复和按调用归属的生产托管来源工厂已经落地。尚缺归档上传与安全解包、签名发布工具、刷新 API、
未完成调用的持久化回执对账、持久化健康/发现 revision、坏版本自动隔离，
以及安装和调用暂存目录的垃圾回收。调用感知的 generation 排空和中断生命周期对账已经完成。

### 4.3 Provider 还缺少反向能力 Broker

Provider 进程现在必须使用固定的最小 OS 权限。需要网络、文件、浏览器或秘密句柄的 Provider 不应获得直接权限，而应通过 Provider-to-Host Broker 请求带 Work 归属的受控能力。该反向 RPC 和每次调用的授权证明尚未实现。

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

当前实际执行队列：

1. Scenario Extraction 与零场景运行边界。
2. Provider-to-Host Capability Broker。
3. Tool Runtime 的恢复、隔离和故障治理。
4. Provider 归档分发、签名工具、持久化调用回执与旧包回收。
5. Linux 可证明执行后端。
6. 在 Contract 稳定后逐步将 Runtime 从 `apps/server` 提取为可复用 packages。
7. Web 黑盒包内的 Brokered Browser 与场景闭环。

同一优先级内只允许并行处理依赖方向已经稳定、不会扩大场景耦合的工作；不得以“并行开发”为由
绕过 Scenario Extraction 的冻结边界。

### P0：Scenario Extraction 与通用运行时边界

当前状态：这是下一项必须先完成的架构修正。Provider 分发、Browser 和任何具体场景能力开发在此项
验收前暂停，避免继续扩大反向依赖。目标不是移动文件，而是让 Core 在不知道任何场景名称和领域语义
的情况下完成构建、启动、调度和持久化恢复。

阶段 A：冻结与依赖边界

- 建立依赖规则：`orchestration-core`、`worker-runtime`、`execution-node`、`evidence-graph` 和通用 Server
  不得导入任何 Scenario Package，也不得声明 `web_blackbox`、`code_audit`、`red_team_lateral` 等具体值。
- 暂停新增 Web 工具、黑盒 Planner 策略、Browser 能力和场景专属数据库分支；允许修复不扩大耦合的缺陷。
- 形成场景侵入清单，覆盖类型、Definition、Worker 拓扑、授权、工具、路由、Prompt、Schema、持久化投影和测试夹具。

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

阶段 C：抽离 Web 黑盒包

- 新建独立 `scenarios/web-blackbox` workspace package，将 Web Definition、能力、Worker 拓扑、阶段、
  授权 Guard、HTTP/Traffic/Session/Browser 工具、输出 Schema、策略和测试移入该包。
- 删除 `orchestration-core` 对 Web Definition/常量的导出，删除 Embedded Worker 对 Web Profile 和 Web 工具的直接引用。
- Web 包通过通用 Contract 显式注册；只有配置安装并启用该包时，Registry 才出现 `web_blackbox@版本`，
  Tool Runtime 才出现 `web.*` 能力，相应 Worker Pool 才能创建。
- 保持现有 Run/Event/Evidence 数据可读；迁移只转换标识符和注册归属，不伪造生命周期事件或执行回执。
- Scenario Package 与 Tool Provider 是两个独立概念：前者定义调查语义、策略和装配，后者提供受控执行能力；
  Web 包可以声明所需 Provider capability，但不得绕过 Tool Runtime、Provider 签名或权限门禁直接启动工具。

阶段 D：架构验收与防回退

- 增加 Core/Server import-boundary 测试，禁止通用层引用 `scenarios/*` 或具体场景常量。
- 增加零场景启动测试：Core、Server、Worker Runtime、Execution Node、Evidence Graph 全部构建并运行，
  Scenario Registry 为 0，默认工具目录不含任何 `web.*`、代码审计或红队能力。
- 增加 Web 包装配测试：启用后才注册 Definition、工具、授权策略和 Worker Pools；禁用或移除后通用底座仍通过测试。
- CI 增加“排除整个 Web Scenario Package 的底座构建”任务，防止通过间接 import 再次把场景拉回 Core。
- 增加开放扩展示例或中性测试包，只使用 `first scenario`、`first role`、`first output` 等名称证明新增场景无需修改 Core。

迁移提交顺序：

1. **边界清单与 CI 门禁**：只增加依赖检查和现状失败清单，不改变运行行为。
2. **开放标识符与兼容读取**：先让 Core 接受注册的字符串身份，同时继续读取现有持久化值；不移动 Web 实现。
3. **Package Contract 与零场景宿主**：建立显式 Registry/Loader、版本绑定和空 Registry 启动路径。
4. **Web 包迁移**：按 Definition/Policy → Worker 策略 → Authorization → Tools/Schema 的顺序迁移，每一步保持测试可运行。
5. **删除兼容入口**：移除 Core/Server 的 Web export、默认注册和旧 import，启用“排除 Web 包构建”作为强制 CI。

每一步形成独立可回滚提交，不允许在同一个提交中同时泛化全部类型、移动全部文件、改数据库格式并重写
Composition Root。任何阶段失败时，应能回退该阶段而不破坏之前的 Run/Event/Evidence 数据。

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

开发内容：

- 扩展双向 RPC，使 Provider 只能通过 Host Broker 请求 HTTP、文件、会话、浏览器、秘密句柄和 Artifact 能力。
- 每个反向请求绑定 Case、Run、Work、Worker、lease、scope、action 和 idempotency key。
- Host 再次执行 Scope Guard、权限交集、风险分级和审批检查。
- Provider OS 网络默认 deny；Brokered 能力返回持久化 Receipt 和 Evidence 引用。
- 限制反向调用深度、并发、字节、超时和递归，防止 Provider 形成代理逃逸或调用风暴。

验收条件：一个网络 deny 的 Provider 可以完成经过授权的 Brokered HTTP，但无法自行访问未授权目标；所有调用均有可追溯回执。

补充验收：用中性 Scenario/Capability fixture 证明 Broker 不认识 URL、浏览器、代码仓库或横向移动语义；
Web HTTP 只是 Web 包注册的一种 Broker capability adapter，而不是 Host Broker 的默认业务规则。

### P0：Tool Runtime 恢复、隔离和故障治理

开发内容：

- Provider 进程采用指数退避、抖动、失败预算和 quarantine，避免崩溃重启风暴。
- 持久化发现 revision、最后成功目录、健康变化和故障原因。
- 将 Provider 日志与模型上下文彻底分离，只保留有界诊断和审计引用。
- 增加按 Provider、工具、场景和 Work 的并发配额与公平调度。
- 建立 Provider 升级兼容检查和工具 Schema 差异审计。

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

当前状态：在 Scenario Extraction 的 Contract 和依赖方向稳定后开始，不能与其混成一次大爆炸重构。
目标是让 Server 回到 Transport、Adapter、Persistence Wiring 与 Composition Root，而不是简单追求目录变小。

阶段 A：依赖图与 Ports

- 为 Scenario、Cognitive、Model、Evidence、Tool 和 Execution 六层绘制实际 import 图，标出领域逻辑、端口、
  SQLite/Fastify Adapter 与 Composition 代码；先消除循环依赖，再决定包边界。
- Runtime 通过 Store、Clock、Event Writer、Model Provider、Execution Node、Tool Registry 等显式端口工作，
  不直接 import Fastify、具体数据库 client、桌面 API 或某个 Scenario Package。

阶段 B：按稳定职责提取

- `scenario-runtime`：通用 Run/Work/Lease/Checkpoint/Recovery、Definition Registry 与调度协议。
- `cognitive-runtime`：通用 Planner/Observer/Worker Loop、上下文蒸馏与认知快照协议；具体策略由 Scenario 提供。
- `model-runtime`：模型路由、Admission、预算、重试、熔断和调用审计协议。
- Evidence、Tool 和 Execution 继续复用现有 packages；只有在职责和依赖证明确有需要时再拆分或重命名，
  不为追求对称目录制造空壳包。
- `apps/server` 保留 HTTP/WebSocket Routes、配置、SQLite 实现、进程生命周期和显式装配。

阶段 C：多宿主验收

- 建立不依赖 Fastify 的 Runtime integration harness，证明 Run、Planner/Observer、Worker 和 Tool Gateway 可直接组合。
- 增加最小 CLI/测试宿主，只依赖 packages 和端口实现，不 import `apps/server/src/*`。
- 增加 package dependency-boundary 测试和循环依赖检查，禁止 Runtime 反向依赖 Server、Desktop 或 Scenario 实现包。

验收条件：Server 仅承担 Adapter 与 Composition 职责；核心 Runtime 可在测试宿主或未来 CLI/Coordinator 中
复用；删除 Fastify 路由不影响 Runtime 包构建；包拆分不改变 Run/Event/Evidence 的持久化语义和重放摘要。

合并门禁：

- 每次只迁移一个有清晰端口的 Runtime slice，并保持公开行为、事件 schema 和测试基线不变。
- 新 package 必须至少有两个消费者或一个明确的非 Server integration harness；否则先保留模块边界，不创建空壳包。
- 禁止 Runtime package import `apps/*`，禁止 package 之间形成环，禁止为了消除类型错误复制领域模型。
- SQLite 查询与 Fastify request/reply 类型不得泄漏到 Runtime public API；Adapter 负责转换。
- 提取完成后删除 Server 中的旧实现，不长期保留双写、双运行时或兼容代理层。

### P1：Web 黑盒包内的 Brokered Browser Execution

开发内容：

- 通过 Execution Node 启动浏览器进程并验证沙箱证明。
- 建立强制 HTTP/SOCKS 代理后端，覆盖导航、重定向、弹窗、iframe、下载、WebSocket 和 Service Worker。
- 浏览器 Session 与 Identity/Vault、Cookie、Traffic、Evidence Graph 和租约绑定。
- 支持 DOM 快照、稳定元素引用、页面差异蒸馏、截图 Artifact 和人工接管后恢复。
- 不引入 Burp 依赖，也不提供直连回退。

验收条件：浏览器无法绕过授权代理；身份撤销或租约过期立即冻结会话；人工接管后 Worker 能从持久化状态继续。

### P1：Web 黑盒 Scenario Package 闭环

开发内容：

- 建立授权资产、端点、参数、身份、页面状态和业务流程图谱。
- Research Worker 生成互相独立的 Hypothesis 与后续 Work，避免单一路径占满预算。
- Validation Worker 采用基线、变量控制、重复验证、反事实和影响确认形成因果证据链。
- 增加身份/权限矩阵、工作流状态覆盖、错误与差异聚类、受控回调服务和覆盖缺口评估。
- Report Worker 只从 verified Finding 和完整 Evidence Chain 生成结果。
- 漏洞知识、测试模板和 Payload 作为可版本化 Web 工具包管理，不写入底座调度器。

验收条件：在多个授权测试应用上完成无人值守探索、人工门禁、因果验证、失败回溯和可复现报告；不能把扫描器单一命中直接升级为漏洞。

### P1：统一运维控制台

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

### 后续独立 Scenario Packages

Scenario Extraction 验收后，各场景按独立包推进，不再通过修改 Core 增加场景：

- 白盒代码审计 Profile：仓库快照、增量 Diff、AST/语义索引、Source-Sink 数据流、验证与修复证据。
- 红队横向 Profile：PTY、远程 Session、跳板与隧道、凭据实体、网络拓扑以及更严格的审批策略。

这些场景不会复制底座，只通过 `ScenarioPackage` Contract 注册自己的 Profile、Worker 策略、
授权策略、输出 Schema、图谱映射和工具 Provider。Web 黑盒是否完成不再是创建其他场景包的代码依赖，
但产品排期仍可选择先完成一个场景的端到端验收。

## 6. 当前质量基线

- 全工作区构建通过。
- `test:fast`：146 个测试文件、559 项测试通过。
- 核心测试覆盖黑板调度、Planner/Observer、证据图谱、模型运行时、租约与审批、Execution Node、Brokered HTTP、Tool Runtime、真实 Provider 子进程崩溃恢复和 Execution Node attestation 拒绝。
- 三项需要真实外部配置的 Live 测试不属于快速基线，发布验收时必须单独执行。
- Tool Provider 控制面新增测试覆盖签名/文件与包哈希拒绝、原子只读发布、符号链接与资源上限拒绝、
  生命周期审计、隐式降级拒绝、显式回滚、调用感知排空、并发命令串行化、中断升级恢复、
  generation 提交回退以及握手身份/版本不匹配终止。

## 7. 最近的明确开发目标

下一项只做“Scenario Extraction 与通用运行时边界”，先建立开放标识符、Scenario Package Contract、
零场景启动能力和 import-boundary 测试，再抽离 Web 黑盒包。该项验收前暂停 Provider 分发、Browser、
Web 黑盒策略和其他具体场景开发；允许继续修复不扩大场景耦合的安全或数据一致性缺陷。抽离验收后
立即进入 Provider-to-Host Capability Broker，而不是先继续堆积具体工具或场景功能。
