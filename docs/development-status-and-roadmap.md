# TraceForge 当前开发进度与生产化计划

更新日期：2026-08-27

## 1. 项目目标

TraceForge 的目标不是通用编程 Agent，也不是某个漏洞扫描器，而是一套独立运行的通用安全智能体底座。底座负责认知调度、黑板协作、证据生命周期、上下文治理、工具运行、安全执行和人工审批；Web 黑盒、白盒审计、红队横向等能力通过 Scenario Profile、Worker 能力和受控工具 Provider 装配。

目标协同结构不是固定两个 Agent。Planner 和 Observer 是常驻的认知与仲裁角色，执行侧按照 Scenario Profile 和任务压力动态创建 Research、Validation、Review、Report 等 Worker。所有角色通过持久化 Run Event、Work Package 和 Evidence Graph 协作，不通过共享自然语言聊天记录协作。

## 2. 进度口径

本文中的“已落地”表示代码、类型、持久化模型和自动化测试已经存在，不代表已经完成真实环境长期运行验收。“生产可用”还要求安装升级、故障恢复、性能容量、安全边界、操作界面和真实授权环境评测全部通过。

当前工程估算如下：

| 范围 | 完成度估算 | 说明 |
| --- | ---: | --- |
| 通用安全智能体底座 | 约 75% | 核心架构与 Provider 控制主链已经成型，缺少反向能力 Broker、完整回执恢复、生产观测与部分执行闭环 |
| 单机生产化能力 | 约 63% | 已具备持久化、门禁、Execution Node、原子 Provider 安装和调用感知升级，但分发、垃圾回收和长稳测试未完成 |
| Web 黑盒实战场景 | 约 35% | HTTP、会话、授权、流量和证据工具已接入；受控浏览器和完整探索/验证策略仍未闭环 |
| 白盒代码审计场景 | 尚未正式开发 | 只复用底座，不在当前开发主线上加入 AST、污点规则等场景工具 |
| 红队内网横向场景 | 尚未正式开发 | PTY、隧道、长期远程会话和高风险审批策略仍待后续装配 |

这些百分比是按目标能力和生产验收项估算，不是按代码行数或测试覆盖率计算。

## 3. 已经落地的底座能力

### 3.1 黑板协作与调度

- Scenario Profile 定义场景目标、执行阶段、Worker 拓扑、能力需求和授权动作。
- Planner 负责基于 Hypothesis、Evidence 和覆盖缺口产生、取消或调整 Work。
- 全局 Observer 独立订阅 Run 与 Evidence Graph 变化，可继续、纠偏、终止分支或终止 Run。
- Worker 使用能力匹配、租约、心跳、幂等键、检查点、重试和过期回收机制执行 Work。
- 同一 Run 可保留多个假设和排队任务，但一次只允许一个验证任务拥有执行权。
- SQLite 事件存储是当前单机黑板事实来源，进程内事件总线负责低延迟唤醒，定时扫描只承担恢复职责。

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

### 4.1 Tool Provider 控制面仍需完成生产化后半段

签名 Manifest、信任根、文件/包哈希、只读原子目录发布、持久化生命周期、控制 API、显式回滚、
启动恢复和按调用归属的生产托管来源工厂已经落地。尚缺归档上传与安全解包、签名发布工具、刷新 API、
未完成调用的持久化回执对账、持久化健康/发现 revision、坏版本自动隔离，
以及安装和调用暂存目录的垃圾回收。调用感知的 generation 排空和中断生命周期对账已经完成。

### 4.2 Provider 还缺少反向能力 Broker

Provider 进程现在必须使用固定的最小 OS 权限。需要网络、文件、浏览器或秘密句柄的 Provider 不应获得直接权限，而应通过 Provider-to-Host Broker 请求带 Work 归属的受控能力。该反向 RPC 和每次调用的授权证明尚未实现。

### 4.3 Web Browser 尚未进入可用执行链

原生 HTTP 已经走 Broker，但 Browser Worker 目前仍因缺少强制代理后端而关闭。需要完成浏览器进程沙箱、CDP 控制通道、所有页面/弹窗/下载/Service Worker 流量强制代理、人工接管和会话恢复，才能禁止直连的同时投入黑盒场景。

### 4.4 Web 黑盒的场景认知策略还不完整

当前底座能调度 Research 与 Validation Work，但还缺少生产级的资产面建模、页面状态覆盖、身份矩阵、业务流程状态机、参数与数据关系学习、验证矩阵、受控外带回调和最终覆盖评估。具体 Payload 和漏洞知识应放入 Web Scenario 工具/知识包，不进入通用底座。

### 4.5 运维与可靠性仍需补齐

- 工具、Worker、Planner、Observer、模型预算和执行节点虽有 API/事件，但缺少统一运维控制台。
- 缺少长时间运行、断电恢复、磁盘耗尽、Provider 频繁崩溃、模型供应商波动和高并发任务的系统级验证。
- 当前以 SQLite 单机模式为主，尚未给出多节点 Worker 的生产部署、队列和数据库拓扑。
- Linux 进程执行因缺少可证明的托管 cgroup 后端保持关闭。
- 凭据实体可以进入受权限控制的黑板，但面向操作者的查看、脱敏、授权与审计体验还未完成闭环。

## 5. 接下来的开发计划

以下顺序按生产依赖关系排列，不是原型阶段划分。

### P0：持久化 Tool Provider Manifest 与供应链控制面

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

开发内容：

- 扩展双向 RPC，使 Provider 只能通过 Host Broker 请求 HTTP、文件、会话、浏览器、秘密句柄和 Artifact 能力。
- 每个反向请求绑定 Case、Run、Work、Worker、lease、scope、action 和 idempotency key。
- Host 再次执行 Scope Guard、权限交集、风险分级和审批检查。
- Provider OS 网络默认 deny；Brokered 能力返回持久化 Receipt 和 Evidence 引用。
- 限制反向调用深度、并发、字节、超时和递归，防止 Provider 形成代理逃逸或调用风暴。

验收条件：一个网络 deny 的 Provider 可以完成经过授权的 Brokered HTTP，但无法自行访问未授权目标；所有调用均有可追溯回执。

### P0：Tool Runtime 恢复、隔离和故障治理

开发内容：

- Provider 进程采用指数退避、抖动、失败预算和 quarantine，避免崩溃重启风暴。
- 持久化发现 revision、最后成功目录、健康变化和故障原因。
- 将 Provider 日志与模型上下文彻底分离，只保留有界诊断和审计引用。
- 增加按 Provider、工具、场景和 Work 的并发配额与公平调度。
- 建立 Provider 升级兼容检查和工具 Schema 差异审计。

验收条件：连续崩溃不会拖垮主进程；坏版本自动隔离；健康 Provider 和正在运行的 Work 不受无关来源故障影响。

### P1：Brokered Browser Execution

开发内容：

- 通过 Execution Node 启动浏览器进程并验证沙箱证明。
- 建立强制 HTTP/SOCKS 代理后端，覆盖导航、重定向、弹窗、iframe、下载、WebSocket 和 Service Worker。
- 浏览器 Session 与 Identity/Vault、Cookie、Traffic、Evidence Graph 和租约绑定。
- 支持 DOM 快照、稳定元素引用、页面差异蒸馏、截图 Artifact 和人工接管后恢复。
- 不引入 Burp 依赖，也不提供直连回退。

验收条件：浏览器无法绕过授权代理；身份撤销或租约过期立即冻结会话；人工接管后 Worker 能从持久化状态继续。

### P1：Web 黑盒场景闭环

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

### 后续场景装配

Web 黑盒闭环达到验收标准后，再复用同一底座开发：

- 白盒代码审计 Profile：仓库快照、增量 Diff、AST/语义索引、Source-Sink 数据流、验证与修复证据。
- 红队横向 Profile：PTY、远程 Session、跳板与隧道、凭据实体、网络拓扑以及更严格的审批策略。

这两个场景不会复制底座，只增加各自的 Profile、Worker 策略、图谱映射和工具 Provider。

## 6. 当前质量基线

- 全工作区构建通过。
- `test:fast`：146 个测试文件、559 项测试通过。
- 核心测试覆盖黑板调度、Planner/Observer、证据图谱、模型运行时、租约与审批、Execution Node、Brokered HTTP、Tool Runtime、真实 Provider 子进程崩溃恢复和 Execution Node attestation 拒绝。
- 三项需要真实外部配置的 Live 测试不属于快速基线，发布验收时必须单独执行。
- Tool Provider 控制面新增测试覆盖签名/文件与包哈希拒绝、原子只读发布、符号链接与资源上限拒绝、
  生命周期审计、隐式降级拒绝、显式回滚、调用感知排空、并发命令串行化、中断升级恢复、
  generation 提交回退以及握手身份/版本不匹配终止。

## 7. 最近的明确开发目标

下一项应完成“Provider 归档分发、安全解包与签名发布工具”，随后补齐刷新 API、持久化调用回执对账和旧包回收。
这些能力完成前，不应继续堆叠新的具体漏洞工具，也不应把开发注入来源当作生产 Provider 启动链。
