# Scenario Process Runtime 与 Package Capability Broker

更新日期：2026-09-03

## 目标

TraceForge 的通用底座不能假设场景是黑盒、代码审计、内网分析或任何其他固定类型。进程协议只处理 Package 身份、工具目录、能力请求、执行归属和生命周期，不包含目标、漏洞、HTTP 状态码或场景判断逻辑。

## 装配材料

生产 Package 的工具实现使用 `traceforge-scenario-process-rpc@1`。SDK 暂时保留的 `createToolSources` 只用于明确开启的
测试/迁移兼容模式；Foundation 默认会在调用工厂前拒绝，不能因为 Package 已签名审核就让其进入可信 Host 进程：

- Package 审核合同声明 `id/version/source/entrypoint`、工具能力和所需宿主能力；
- 可信宿主独立提供绝对可执行路径、工作目录、受控环境、服务归属、权限 Profile 与资源上限；生产路径只能交给 Execution Node 启动；
- Execution Node 在真实进程创建后返回进程、节点、PID、沙箱后端、权限指纹、资源上限指纹和网络模式，Runtime 逐项核对后才接受；Package 配置不能自报 attestation；
- 握手必须返回 Scenario 专用 Profile 和完全一致的 Package id/version；工具 source/version 与能力列表再次复检。

因此，场景包不能通过修改自己的清单选择宿主可执行文件、注入宿主环境或自称已经获得某项能力。

生产组合根的 `allowInProcessScenarioDevelopment` 默认关闭；它只改变旧夹具兼容行为，不会被报告为生产隔离。
`ScenarioPackageRegistry.toolSources` 自身也要求逐调用显式 opt-in，避免其他组合根绕过 Foundation 默认值。
诊断输出固定 `inProcessScenarioExecution: "disabled" | "development_opt_in"`，生产部署可以直接拒绝误开的构建。

## 能力调用

进程可反向调用七组通用能力：授权、证据、Artifact、State、Execution、Session 和 Traffic。未声明 Session/Traffic 的 Package 不会触发对应 Adapter 装配。Execution 暴露有界 `request_http` 与 `request_http_session`，复用本机 Execution Node 的 Brokered HTTP、资源再授权、任务归属、权限快照、超时、响应容量和网络回执，不返回裸节点、套接字或进程句柄。Session 只返回身份/会话描述符，秘密头、Cookie 和命名秘密值只在可信 Host 内解密与注入；Traffic 只返回按当前 Case/Run 归属的脱敏历史。实际开放集合取 Package 声明与宿主 Handler 的交集，任一侧缺失都拒绝装配。

每次反向 RPC 必须指向仍在进行的父工具调用。Case、Run、Work、Worker、scope、lease 和权限快照由传输层从父调用复制，子进程不能提交或覆盖。Server Adapter 再注入 Package id/version，并拒绝多余归属字段。请求/响应大小、并发数、截止时间、JSON 形态、标识长度、证据引用和最多 4,096 个内存回执均有界。

Session 每次使用都重新核对 Case、Run、Scope、身份版本、撤销状态、有效期和当前 Work lease；同一 Session 不能同时转交给另一个仍有效的 lease。秘密头只可发送到身份明确登记的 HTTP(S) URL 前缀，Cookie 继续按 domain/path/secure/expiry 匹配。敏感表单或 JSON 字段通过命名秘密句柄由 Host 构造，文本响应中的短期值只能通过有界、精确起止分隔符捕获并加密回写 Session；进程只拿到捕获名称。`Set-Cookie` 不返回进程，响应和 Traffic 会替换已知秘密，Traffic 的请求头只保存 `present/redacted`、非模板正文只保存摘要。该层提供秘密传递边界，不替场景判断登录语义、身份关系或安全结论。

能力调用以 Package、能力、动作、输入和 Work 归属形成幂等指纹。同键并发请求合并，进程乃至整个宿主重启后的同键请求从 SQLite 重放原回执；同键换输入会冲突。调用外部 Handler 前先落 `pending` claim，成功后再落完整回执。若宿主在两者之间中断，新宿主把结果视为“未知、需要对账”，拒绝自动重做，避免把一次可能已经发生的副作用执行两遍。

`pending` claim 同时保存 Package/版本、generation、父请求、能力/动作、输入指纹和 Case/Run/Work/Worker/scope/lease 归属。它不保存原始输入，也不把某类能力的成功判断写进底座。受信运维面只能使用部署侧配置的 Ed25519 恢复权威；签名断言必须逐项覆盖原 claim、有效期和最终回执。外部事实确认成功时补写原回执，确认从未执行时才转成 `retry_allowed`；重试只能沿用原身份和输入指纹，并增加 attempt。超时、重启、异常文本或本地观察均不能自行解除围栏。

部署也可以装配 `ScenarioCapabilityRecoveryIssuer`。Issuer 把一个能力无关的签名器与部署提供的 Observer 组合起来：Observer 只返回“成功并附原回执”或“确定未执行”以及稳定外部证据引用；Issuer 固定 Package/能力作用域、Ed25519 私钥、有效期、最大证据年龄和观察截止。私钥不进入请求、SQLite 或审计。多个 key generation 可并存，旧 key 被部署撤销后，旧证据立即停止放行；新 key 继续沿用相同 claim 合同。Observer 怎样检查外部系统仍属于对应能力 Adapter，不属于 Core。

Issuer 只接受先经过 `verifyScenarioCapabilityRecoveryObserver` 的同一 Observer 实例。部署验收至少使用两个不同 claim，重复观察并重新读取稳定证据引用，核对回执完整身份、结果确定性、预取消响应以及观察前后由可信宿主采集的外部状态。验收结果有明确到期时间且不能复制给另一个外观相同的 Adapter。这个测试套件提供一致的上线门槛，但可信状态快照和证据读取器仍由部署负责；本地确定性夹具不等同真实外部系统认证。

## 生命周期

- 每次启动先在 SQLite 监督账本中预留单调 generation；每代 Execution Node 执行使用独立幂等身份，旧 generation 不能继续调用宿主能力。
- 启动、就绪、退出、失败、宿主中断和撤销均持久化。新宿主把上次仍为 reserved/started/ready 的代次保守标成 `interrupted`，不会猜测它从未运行。
- 重启预算按 Package 精确版本跨宿主持久化，重启应用不能刷新次数；清单、启动材料或预算在同一版本内变化时拒绝继续，要求发布新版本。
- Package 撤销会先写可信账本，再关闭进程、终止在途能力并永久阻止后续 generation。
- 工具调用与 Provider/Execution 共用 Foundation 公平调度器，接受全局、每包、每工具、每 Run 和每 Work 限额。
- 每个进程 generation 在真实派发前进入 `ProcessExecutionCapacity`；退出/失败只结束本地 lease，并保留 terminal/unknown 占用，直到既有独立清理证据证明 OS 执行树可释放。
- 超时、取消、损坏帧和进程退出会拒绝未完成请求；自动重启受显式预算控制。
- 真实 SIGKILL 测试证明下一次发现会创建新 generation，不复用旧能力授权；生产装配测试还证明正常关闭、新 Runtime 重建、generation 递增和能力回执不重复派发。
- 运维控制面提供有界分页的版本、generation、能力状态、退役档案和不可变命令审计查询；查询不返回原始能力输入或回执输出。
- 版本必须先经过 Package 信任撤销，等待所有 generation 终结、所有 Process Execution 占用获得既有可信清理证明、所有能力调用离开 `pending`，才能退役。退役把完整热回执压缩进不可变档案，热表保留永久身份、指纹、摘要和防重放索引。
- 退役档案可在每次独立授权后导出为 `traceforge.scenario-process-retired-archive.v1`。传输包包含 Package 精确版本、原始/压缩大小、档案摘要、创建/导出时间、Base64 压缩正文和 Ed25519 签名；接收侧在解压上限内重新核对签名、摘要、长度及内部 Package 身份。导出 key 可独立轮换或撤销，重放命令仍重新授权。
- 可选 `ScenarioProcessColdArchive` 使用独立文件系统根目录接收签名包，不持有或访问活动 SQLite。接收先重新授权、解析、验签、解压核对，再用同目录 staging、文件与目录 `fsync` 和原子 rename 发布；命令回执与保留记录也只写在冷库目录。重复命令会重新授权并核对固定请求指纹。
- 冷库默认状态是 `forensic_hold`，不会按墙上时间自动删除。销毁必须先以预期 revision 独立授权解除保留，再以另一个命令独立授权进入 `purge_prepared` 并只删除已知的四个档案文件；未知条目、符号链接、版本冲突或授权失败均停止。记录明确写 `secureErase: false`，只证明精确文件删除，不声称介质安全擦除。
- 接收 staging/发布后与销毁准备/文件删除后的四个真实 SIGKILL 窗口均可由新宿主收敛：已发布档案不会重复生成，未完成 staging 不会冒充档案，已删除档案不会因恢复而重建，旁边的其他摘要目录不受影响。
- 对账证据写入和能力结算处于同一 SQLite 事务；退役档案写入、热正文替换、版本状态和审计也处于同一事务。真实宿主在事务内或提交后被 SIGKILL 的四类回归证明：新宿主要么重新执行完整命令，要么重放已提交审计，不会出现半个回执或半个退役版本。

## 声明式宿主合同

Package 的授权和输出规则现已改为由宿主固定解释器执行的有界数据合同：

- `traceforge.scenario-scope-policy.v1` 只允许声明动作白名单/拒绝表、Scope JSON 的字节与递归深度，以及资源的固定值、`payloadPath` 选择或显式词法前缀；不接受表达式、正则、脚本或动态函数。前缀只做逐字匹配，底座不会猜测 URL、文件路径、ARN 等领域语义；规范化和安全前缀的生成仍由场景负责。
- `traceforge.scenario-output-contract.v1` 固定 kind/version、摘要和引用容量、可选引用前缀，并可用固定 selector 把输出字段映射为证据；不能调用代码或任意转换数据。
- 未知字段、未知 selector、非 JSON Scope、超深/超大载荷、超限输出和不匹配引用均 fail closed。声明的完整内容进入 Package 合同摘要、信任复检和迁移兼容判断，而不是只比较名字和版本。
- Foundation 生产默认拒绝旧 `parseScope`、`authorizeResource`、`validate`、`mapToEvidence` 回调；`allowLegacyScenarioContractDevelopment` 只供显式测试/迁移，并在诊断中标记 `development_opt_in`。

因此生产 Host 内只保留通用解释器；场景自己的可执行工具正文继续留在 Scenario Process。`ScenarioDefinition`、授权和输出合同现在均可由签名 `scenario.json` 加载，不再要求受信宿主编译场景对象。

## 当前边界

生产装配已经不接受同进程 Scenario 工具工厂或配置自报的沙箱证明；但“OS-backed”仍以 Execution Node 实际可用的受信后端为准。当前 macOS 开发机只能用测试启动器验证协议和证明核对，不能冒充 Windows AppContainer/Job Object 双模式实机验收。Execution Node 的进程观察日志仍是“主进程已退出”的证据，不自动等于整个 OS 进程树已可信清理；未知清理继续进入既有容量/恢复围栏。

Package Definition、授权、输出与证据映射已能以纯数据表达；生产默认不执行这些位置的 Package JavaScript。Foundation 也已可从已审核材料里的 `scenario.json` 构造冻结 Registry，并把入口与本地资源绑定到同一材料清单。它仍不是下载/上传或商店式安装器；宿主启动 Profile 和 OS 权限继续由可信部署提供，不能由描述文件自选。详见 [Scenario Package 描述文件](scenario-package-descriptor.md)。

监督账本已有能力无关的签名对账合同、恢复签发器和统一 Observer 上线验收，但底座不会自己猜测成功：部署仍须为实际 Host Capability 实现 Observer，并用真实外部事实源完成验收。活动数据库内的退役档案仍只回收热正文、不删除永久键，也不是数据库备份；可选冷库接收端已经与活动 SQLite 隔离，但仍是单宿主文件系统，不是对象存储、多节点共识、异地副本或安全擦除服务。自动保留期策略刻意未启用，解除保留与销毁都要求显式授权。产品不提供远程宿主。开发专用 `ScenarioDevelopmentProcessLaunch` 仍供独立协议测试使用，但 Foundation 生产装配会拒绝它。
