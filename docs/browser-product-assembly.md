# 本机 Browser 产品接线与验收边界

2026-09-07。本文约束本批整改，不引入远程节点、多 Server 或多用户平台。

本轮最新状态：真实 macOS outer-only Browser 已通过原生启动器、Execution Node、受管 Controller/CDP、实际 HTTP Broker、正文/回执落盘链路验收，覆盖重定向、子资源、下载、截图、接管与授权撤销。9 文件 64 项相关测试通过。初始空白页、授权拒绝审计与监督失败状态已修复；下文“该组合 CDP/Broker 尚待验收”由本段覆盖。测试专用 Controller 未进入生产发行入口，Server/SQLite 仍是单独装配回归，不能宣称真实桌面全栈验收。正式安装合同、Mach 身份边界和发行材料仍须收尾；普通工具策略不变。详细复现和保证范围见开发计划顶部。

最新覆盖：用户同意外层 Seatbelt 保留、内层 Chromium sandbox 关闭的独立诊断。显式 `--outer-sandbox-only --browser-services --isolation-suite` 下，真实 headless-shell 渲染、授权文件读取、越权文件拒绝、直连网络拒绝、取消清理五项通过；原生相关回归 23 项通过。修复了退出进程被误判为采样异常的竞争，并收紧诊断通过条件。生产参数仍拒绝 --no-sandbox，未注册该诊断策略；减少的浏览器内部防护和 Mach 前缀非 Run 绑定问题不能隐去。该组合的受管 CDP/Broker/证据链仍待端到端验收。以下兼容失败及“尚未取消任何一层”均为历史记录，以本段和开发计划顶部为准。

当前根因覆盖：命名 Mach 注册与标准设备诊断后，Chromium 子进程在重新初始化 Seatbelt 时 EPERM。独立原生 C 探针确认：直接 sandbox_init 成功，外层 Seatbelt 内同调用失败。22 项相关测试通过不等于浏览器验收。诊断权限未注册生产；global-name-prefix 不是 Run 身份隔离，不能包装成受管 IPC 证明。后续不能只继续加白名单，需明确选取外层/内层隔离边界及其保证变化。两层目前不可用，尚未取消任何一层。

最新权限适配结论：用户已接受 Browser 独立最小系统权限。候选仅在诊断脚本显式启用，IOKit 方法过滤不得省略；本机 sandbox_apply 对带过滤器的浏览器与 true 探针均返回 EPERM。未放开普通工具、未注册生产 Browser，也未扩大网络权限。后续转向独立浏览器源码对不可用系统通知的安全降级；此前等待用户接受最小权限的描述已过时。详见开发计划顶部。

最新覆盖：macOS pipe ProcessLauncher、显式 sampled_terminate 接受合同和 Server 原生 preflight 已实现，27 项本机相关测试通过。安装器已支持 darwin/arm64，但真实 Chrome 在当前隔离内 SIGABRT，尚未通过 Browser 实机验收；生产 Browser 与桌面任务闭环仍不可宣称完成。桌面新对话只保存文本，不自动派发调查，retirement fence 未解除。下文“无 ProcessLauncher/无 pipe/只接受 Linux Windows”是历史状态，以开发计划顶部最新记录为准。不得将辅助程序完整性清单当签名、公证或浏览器发行审核。

补充诊断：官方 headless-shell 152.0.7977.82 空环境基线可渲染，但同一构建在当前策略下于 IONotificationPortGetRunLoopSource 崩溃，清理成功。浏览器运行需要独立审核 macOS 系统服务边界，不能向通用策略直接加入 IOKit/Mach 放行。测试下载不是生产供应链验收；可复现入口为 scripts/diagnose-macos-browser.mts，详见开发计划。

首发平台：macOS Apple Silicon（darwin/arm64），Linux 验收后移。下文安装器当前仅接受 Linux/Windows 是待整改的实现限制，不是产品支持决策。下一完整任务是 macOS 本地隔离后端及 Browser 整链，不以 Linux 主机或远程执行作为首发前提。此前 macOS Chrome 控制测试不等于 OS 隔离证明，不能只放开平台检查就启用生产能力。

用户已接受 macOS 资源监测超限后终止方案，覆盖下方等待确认状态；文件/网络隔离不降低。通用预算累积与监督循环已有实现及单元验证，但原生采样、清理屏障及生产装配尚未完成，因此现阶段仍不启用 Browser。后续必须将监督预算与硬配额明确区分，不能复用布尔值伪装成同一种保证。

后续实现覆盖：原生采样与有界 stdio 受管组入口现已实现，3 文件/19 项当前 Mac 测试通过；监督者使用独立控制/遥测 FD、保留根 PID 至组内无存活成员、拒绝目标 setsid/setpgid 和对监督者发送信号。CPU/内存/数量超限、取消、正常退出及遗留子进程清理已有真实测试。该入口目前仅接受 closed stdin、空环境、无 PTY，尚非产品 ProcessLauncher；Browser Controller 的长期 pipe/control 适配、发行 preflight 和资源保证协商未完成，所以 Browser 仍关闭。不得将这组结果写成生产浏览器已验收。

2026-09-07 原生策略进展：独立 macOS Seatbelt 编译器及本机文件/回环网络/子进程继承测试已实现并通过，但未作为生产启动器装配。系统 sandbox-exec 手册标记该接口废弃，dyld-support.sb 声明为可变的系统私有接口；因此必须区分当前系统上的实验结果与长期发行支持。资源探针设置 RLIMIT_RSS 返回 EINVAL，资源预算采用监督终止还是保留进程树硬配额正在等待用户确认。策略编译结果明确不声称资源限制与进程树清理已具备。

## 已实现的装配链

Web Scenario `web.browser.inspect` → Scenario Process 能力 RPC → Server `createScenarioBrowserHandler` → `BrokeredBrowserRuntime` → 本机 Execution Node → HTTP Broker → 网络回执与 Artifact。

宿主可通过 `SecurityAgentFoundationOptions.browserInstallation` 装配实际安装校验器与 SQLite 正文存储，或通过互斥的 `browserDeployment` 注入实现；均未提供时明确不可用。Server/桌面直接启动均读取显式 `TRACEFORGE_BROWSER_INSTALLATION` 环境变量指定的配置 JSON，buildServer 提供 `browserInstallationPath`。文件限 16 KiB，拒绝未知字段、相对路径、无效摘要/资源值与多个安装来源冲突。安装配置是宿主信任输入，不来自模型、Scenario 或浏览器 RPC；没有默认浏览器探测和无沙箱回退。当前未随产品提供生产发行材料，不能宣称开箱即用。

安装配置包含绝对路径 releaseDirectory、独立 sourceAuthorityPath、固定 nodeExecutable/nodeSha256、scratchDirectory、expectedSandboxBackend/expectedBackendMeasurement 和 resources。发行目录必须包含 release.json、source-lock.json、source-review.json、build-attestation.json 及声明的 Controller/Chromium 文件树；每次准备重新验证实际内容。信任文件不能位于发行或 scratch 树内，发行与 scratch 必须分离；调用必须已具有所需只读发行授权和 scratch 写权限，不自动扩大权限。当前生产安装器仅接受 Linux/Windows；平台名称通过检查不等于原生隔离验收通过。

SQLite 正文以 Case/Run/Work/Session 和摘要归属，单项上限 4 MiB，总量 256 MiB/10000 项。内置安装装配把正文、索引、索引幂等命令写入同一事务；失败全部回滚，已有正文不可修改。启动维护只回收没有索引引用的正文；已登记证据保留，达到配额拒绝新增，不自动删除证据。inspect 返回 Artifact 描述，Scenario 的 `web.browser.read` 按 artifactId/offset/length 经能力 RPC 读取至多 64 KiB 分块；检查当前调用、授权、Package/Case/Run 归属、正文摘要/大小，不重新启动浏览器。桌面图片查看器不属于此后端整改的交付范围。

scratch 在创建前持久登记，派发前保存实际进程键。启动恢复仅处理登记目录：未派发或已终结的可回收；派发过的要求既有容量记录全部为 terminal_observed/released，无记录或未知状态保留。清理精确目录并拒绝符号链接替换，未登记目录不碰。该恢复在单 Host 接受工作前执行，不支持多 Host 同时运行同一数据库，也不替代已有签名清理流程或释放进程容量。

一次调用只启动一个临时浏览器，导航并保留 DOM，可选截图，然后关闭。不提供跨调用会话、任意脚本执行、交互式登录或人工接管 UI。页面请求可能产生副作用，工具标记为 bounded_write，不标成纯读取。页面观察只是证据材料，不自动构成 verified Finding。

## 执行与安全约束

正文读取还要求原子保存时登记的索引—正文绑定；仅通过通用 Artifact RPC 伪造同名索引，不能取得其他 Package 的 Browser 正文。绑定登记与正文/索引同事务，不能只凭可猜测的 contentRef 授权。

- 每次请求复查当前 Work 调用、租约及授权范围；进程进入已有共享容量账本。启动权限必须与调用权限一致，Browser Runtime 再将子进程网络收窄为 deny，由宿主代发 brokered HTTP。
- 必须提供预期原生后端及测量身份；不默认选择开发机 Chrome、不提供 direct 网络或无沙箱回退。
- 浏览器限时 30 秒、单次最多 64 个请求和 3 次观察；能力 RPC 有既有取消与回执机制。退出结果不确定时保留容量占用，不声称进程已清理。
- DOM/截图正文由宿主 Artifact 内容端口保存；inspect 返回索引、摘要和网络回执，需要正文时再授权分块读取。索引归属固定到当前 Package/Case/Run/Work。
- 重建或修改 Scenario 运行物后，发行时必须重新生成签名包，不能用旧签名冒充新内容。

## 网络支持范围的明确决定

当前工具联网采用结构化 HTTP Broker。普通工具进程的 `network: brokered` 不是透明代理承诺；没有实现该传输的原生启动器继续拒绝。需要任意 TCP/UDP 或其他协议的工具暂不支持，不能为了“兼容所有 CLI”放开 direct。后续只有具体可复用需求成立才扩展协议能力。

## Blackboard 不扩建分布式系统

进程内 ChangeBus 是低延迟通知，不是持久数据来源。现有 SQLite 事件、语义游标、启动恢复与周期检查仍为单宿主恢复基础。本批未新增 outbox 或消息中间件，也不声称已有游标等于全部 exactly-once 证明。

## 三个完成门槛

| 门槛 | 当前结论 |
| --- | --- |
| 核心实现 | Browser Runtime 原有实现，保持其平台证明约束 |
| 产品装配 | 有界 inspect/read、显式安装文件入口、原子正文存储和启动恢复已实现；签名测试材料与实际 Runtime/SQLite 联测通过 |
| 生产验证 | 未完成；需要真实发行树、可信原生隔离与 Linux/Windows 平台验收 |

## 生产验收所需材料

安装者提供经过真实评审的发行树、树外 source authority、固定 Node 身份、已验收原生 Helper 身份及预创建 scratch 目录。安装 JSON 的字段对应上文配置项；资源对象包含 cpuTimeMs、memoryBytes、maximumProcesses、writeBytes。调用权限必须预先覆盖规范化后的发行/信任只读路径与 scratch 写路径，不能给发行树任何后代写权限。新 Scenario 运行物需要重新打包签名。

本轮 179 项回归包括真实文件和 Ed25519 校验，但 Chromium 字节及执行控制器是明确夹具，不是生产发行或 OS 隔离证据。下一完整验收以真实材料在受支持本机沙箱运行 inspect/read 链，检查 Broker 网络回执、证据重开和退出恢复。没有这些外部条件时保持关闭，不增加远程服务或拿开发 Chrome 顶替。
