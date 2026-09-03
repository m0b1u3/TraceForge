# 自定义执行来源的宿主治理契约

## 产品与信任边界

这是单用户安全智能体底座的执行边界，不是账号、租户或用户权限平台。
自定义工具和 Scenario 不应因接入方式不同而绕过进程配额、任务归属、取消和重启围栏。

本机制约束**宿主发放的执行端口**。生产 Scenario 工具工厂现已在调用前拒绝，只能使用进程型 Package。
宿主自身显式编译和注册的 `governedToolSources` 仍是可信代码：它可以自行 import `node:child_process`，也可能事先在闭包中持有外部注入的节点。
声明、类型和 AsyncLocalStorage 均不能阻止这种任意代码行为，不能声称已经实现恶意插件隔离。
不可信可执行包必须使用受控的进程外 Provider/MCP 和经过验收的系统沙箱；不能把它当本机工厂加载。
原生可信清理签发、Windows 双模式验收和 Linux 沙箱的既有缺口不因本批消失。

## 装配契约与兼容策略

`worker-runtime` 导出 `GovernedExecutionSourceRegistration`、`ExecutionSourcePolicy` 和 `GovernedExecutionPort`。
注册项固定 `source`、`version` 和 `process: "denied" | "governed"`，由 `create(port)` 返回 Discovery source。
工厂返回的来源、发现工具的来源/版本必须匹配；缺省模式、无效身份/截止、无节点的 governed 模式拒绝。
声明 process-denied 却发布需要 sandboxed process 的工具也拒绝。

生产 `SecurityAgentFoundationOptions` 提供：

- `governedToolSources`：明确声明的自定义来源；新代码使用这个入口。
- `governedToolProviderFactory`：对已核验安装包创建上述注册项，来源/版本锁定安装包身份。
  工厂只得到安装信息副本；不能通过改写参数改变身份比较。仍经过原 Provider 生命周期/目录门禁。
- `scenarioSourceExecutionPolicies`：按具体 source 声明通用宿主策略，不在 Core 写某种场景的判断。
- `allowUnmanagedDevelopmentSources`：显式测试/迁移逃生开关，默认关闭。
  没有此开关时，旧 `toolDiscoverySources` 非空或 `toolProviderSourceFactory` 存在即拒绝初始化。
  开关只表示承认未治理来源，不赋予生产安全保证；旧、新 Provider factory 不能同时配置。

旧 Scenario 工厂只在 `allowInProcessScenarioDevelopment=true` 的测试/迁移模式获得 `context.execution`；该开关默认关闭并进入诊断。
兼容字段 `context.executionNode` 不再是裸节点，
只保留绑定当前调用的 brokered HTTP；进程、文件、恢复/adopt、handshake 等原始方法全部拒绝。
生产模式不再装配旧 Scenario source；新增 Scenario 工具必须声明 Scenario Process runtime，并由 Execution Node 启动。
Web 黑盒 `0.3.0` 已改用 Scenario Process，并通过 `traceforge.scenario.execution@1` 申请上述受控 HTTP；认证请求额外经 Package 声明的通用 Session/Traffic 能力使用宿主秘密句柄和脱敏历史，Web 规则仍只存在于场景包。旧同进程工具只保留为显式测试/迁移兼容路径。

## 操作边界

端口只有两个方法，不返回原始节点或进程管理句柄：

- `executeProcess(input)`：使用内置显式程序/参数向量、目录、输入、输出上限及资源限制契约。
  宿主生成独立子进程 key，固定来源/版本/操作以及原父 Invocation，走共享 `ProcessExecutionCapacity`。
- `requestHttp(input)`：沿用现有 Brokered HTTP 的 Scope/网络授权；宿主覆盖归属、权限和请求 key。
  旧兼容 HTTP 还核对调用者提供的归属和权限，防止意外串用。

Work 身份和权限在进入工具时由宿主取快照，交给工具的是另一份副本；不接受工具通过端口自行选择任务或父 Invocation。
私有异步上下文绑定来源与本次调用，工厂构造阶段、其他来源、操作结束后的定时器不能继续使用端口。
进程排队前、拿到名额后、实际派发前核对活跃 Run/Worker lease/父 Invocation；HTTP 派发前也核对所有权。
节点的沙箱/输入/Scope 授权仍必须独立通过，配额不是授权。

发现阶段默认没有 Work，也没有进程权限。需要发现进程时，可信宿主必须显式提供 `discoveryService`：
实际 attribution、权限和同步 `authorize()` 回调，记 `kind=service, operation=discover`，不新增伪造 Work/Invocation。
服务授权在排队与派发检查点重新检查；误写成 async 回调会拒绝，不把尚未完成的 Promise 当作批准。

## 生命周期、上限和恢复

发现最多等待 15 秒，工具最多 300 秒且不超过声明截止/租约。源关闭、调用取消或超时使端口失效，
传递 AbortSignal 到进程工具；迟到的 start 结果收到后仍请求清理。每次操作最多挂起 64 个宿主操作。
工具即使不 await 已经提交的宿主操作，宿主也会等待这些操作结束再返回结果；失败不能包装成整体成功。
任意插件自身非合作 Promise 不保证停止运行，但已关闭作用域不能再派发宿主操作。
HTTP 节点接口没有独立 AbortSignal：限制请求超时并丢弃取消后的迟到响应，不宣称瞬间撤销已发出的 HTTP 副作用。

正常退出只是 `terminal_observed`，不是进程树清理证明。取消/不确定结果保留占用，
重启加载原账本；只有从未派发的预留可以自动释放，其他释放继续要求独立可信证明。
子进程清理证明不等于父工具结果证明，不改写 Invocation 状态，也不自动重试。
同一 Work 的第二次进程启动可能被前一次保留占用挡住，这是现有 perWork 上限/清理信任约束，不自动绕过。
不支持自定义长期后台进程、交互式句柄、跨调用采用旧进程或多活宿主。

## 覆盖诊断与验证

`GET /api/security-tools/process-capacity-policy` 增加 `governedSources`，列出注册来源、版本、模式、
custom/scenario_process 来源类型，以及开发逃生开关/旧工厂是否启用。
这里是**装配声明**，不是实时目录健康或 OS 隔离证明；实时状态仍查 Tool Runtime。
`arbitraryJavaScriptIsolation=false` 固定显式展示；禁止把装配成功当作任意 JS 已隔离。

新增集成测试覆盖 Work/服务归属、跨端口竞争、纯内存零占用、伪造模式/身份、上下文与策略快照、
队列所有权变化、关闭/截止/迟到启动、后台回调拒绝、磁盘重启、旧配置门禁、实际 HTTP Worker 装配、
Provider 安装身份和 Scenario 兼容端口。节点模拟器只证明协议与治理行为，不是平台沙箱验收。
完整测试与构建基线见开发计划第 6 节。
