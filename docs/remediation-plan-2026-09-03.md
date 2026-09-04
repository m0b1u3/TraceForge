# TraceForge 继续开发前整改计划

更新日期：2026-09-04
基线提交：`9b3fe97`
状态：执行中；前三项 P0、Linux 部署仓库实现和 Web 构建结构整改已于 2026-09-03 完成，Structured Worker 收口、Brokered Browser Core、Host/进程控制协议、CDP 策略、Chromium pipe、DOM/截图/控制/人工接管、可复现 Controller、真实 macOS Chrome 集成、来源锁/离线评审签名/安全解压及 v3 整树发行安装门禁于 2026-09-04 完成；Linux 实机终验等待可用真机，当前继续建设官方 Chromium 源码固定、自构建证明与许可证清单

## 1. 整改目的

当前仓库已经具备可运行的通用安全智能体底座和首个 Web Scenario，但仍存在三项会直接破坏既有安全边界的现实债务：本机控制 API 缺少真正认证并可回传 LLM 明文密钥、旧 MCP 管理器可绕过 Execution Node 直接启动进程、Web 黑盒新旧两套实现并存。继续增加场景能力前，必须先一次性清理这三项 P0。

本计划严格区分层次：Foundation/Core 只处理通用安全、执行和 Runtime 边界；Browser Runtime 只处理浏览器进程、控制传输和网络拦截，Web 登录、页面理解与验证语义只留在 Web Scenario；最小 Code Audit Scenario 只用于验证通用性，不把代码审计特判写入底座。

## 2. 固定产品边界

- 产品是单用户、单宿主工具，不建设账号、租户、远程管理、多节点或分布式 Worker。
- 不恢复远程 Execution Node，不建设 Node Registry。
- 桌面自动更新系统继续暂缓。
- 真实模型联调与 24/72 小时长稳继续按既定决定暂缓，不能把离线测试写成真实模型验收。
- 不为增加 Worker 数量、动态 Agent Factory 或复杂多 Agent 编排扩建底座。
- 不允许为了 Web、Code Audit 或其他场景向 Core 增加场景常量、业务流程、漏洞类型或 Payload。

## 3. 第一整改批次：三个 P0 一次完成

这三个问题作为一个完整整改批次交付，不在只增加一个中间接口后结束。

### 3.1 本机 Control API 鉴权与 LLM Secret 整改

归属：本机可信宿主/Application 控制边界，不是多用户系统，也不是 Scenario 能力。

整改内容：

- Desktop/可信启动器生成至少 256-bit 随机本机控制凭据，并通过不进入模型、工具、URL、日志或页面持久状态的可信通道交给 Server/UI。
- Server 对敏感或写操作 API 强制校验控制凭据；至少覆盖 `/api/config/*`、`/api/scenarios/*`、`/api/approvals/*`、`/api/execution/*` 和 `/api/foundation/*`。
- Origin 检查继续用于浏览器来源约束，但不能再被当作 API 身份认证；无 Origin 请求不得因此自动获得控制权限。
- 删除 `POST /api/config/llm/reveal-key`，或使任何等价路径永远不能返回完整密钥。UI 只能看到是否已配置和不可逆掩码。
- LLM 密钥不再以普通 JSON 明文长期保存。Desktop 优先接系统 Keychain；独立 Server 模式只接受环境/宿主 Secret Vault 引用。迁移不得把旧明文写入日志、响应或审计正文。
- 健康、启动恢复等确需匿名读取的最小端点必须逐项白名单，不得用大范围路径例外。

验收条件：

- 无控制凭据、错误凭据、跨进程窃取旧票据、重启后旧票据、无 Origin 的脚本请求均不能调用受保护 API。
- 浏览器可信 Origin 但缺少控制凭据仍被拒绝；拥有控制凭据但来源不可信的浏览器请求也被拒绝。
- 仓库、运行数据库、配置文件、HTTP 响应、日志和前端状态中均找不到完整 LLM 密钥。
- 单用户本机操作仍可完成配置、审批、Scenario 管理和执行管理，不引入账号/租户表。

### 3.2 删除旧 MCP 直接启动旁路

归属：Foundation 执行边界与 Application 组合根整改。

整改内容：

- 从 `main.ts` 生产启动链删除旧 `McpManager.connectAll()` 及其 `StdioClientTransport` 直接启动路径。
- MCP Tools 统一走 MCP Adapter → Tool Provider/Capability Registry → Governed Execution → 本机 Execution Node。
- MCP Context 读取也必须继续受精确 Package/Profile、授权、撤销和容量边界约束；不得通过“只读资料”名义恢复无治理进程启动。
- 旧配置若暂时需要迁移，只能产生明确诊断或离线转换，不能在生产中静默回退到 Server 直接 spawn。
- 边界门禁禁止 `main.ts`、Server 路由或 MCP 管理代码重新直接创建 stdio 子进程。

验收条件：

- 生产启动与真实 MCP 调用只有一条受治理执行路线。
- MCP 进程具备 Execution Node 归属、权限/资源指纹、租约、取消、审计和清理事实。
- 缺少受信 Profile、沙箱证明或授权时 fail closed，不回退直启。

### 3.3 清除 Web 黑盒双实现

归属：Web Scenario 清理，不是 Foundation 功能开发。

整改内容：

- `traceforge.web-blackbox@0.3.0` 的数据描述 Package 与 Scenario Process 成为唯一生产实现。
- 删除正式源码中的 `WEB_BLACKBOX_PACKAGE@0.1.0`、`createToolSources()` 同进程实现和要求 `network: direct` 的旧 Browser Tool。
- 必须保留的迁移数据或兼容样本移入 `test-fixtures/legacy-web-blackbox`，不得被生产构建、工具发现或完成度测试引用。
- 测试统一验证生产描述文件、构建产物和 Scenario Process，不再用旧实现通过来证明新实现可用。
- Foundation/Core/应用组合根继续不知道 Web 工具、动作、流程和 Browser 语义。

验收条件：

- 全仓只有一个可装配的 Web 黑盒 Package 身份和一条生产工具实现链。
- 无 `network: direct` Web Browser、无生产同进程 Web 工具工厂、无测试借旧实现冒充生产覆盖。
- 零场景启动、Web Package 安装/撤销及完整 Foundation 边界门禁继续通过。

## 4. 第二整改批次：Linux 本机部署闭环

### 第一整改批次实际完成记录（2026-09-03）

- Control API 继续由现有随机 256-bit、仅内存、可轮换/撤销/过期且重启失效的 Host Capability 保护；Electron Main 现在取得 management channel，只对当前随机 loopback Server 的 `/api/*` 与 `/ws` 请求注入凭据，凭据不进入 URL、Renderer 状态或持久化配置。没有凭据的可信 Origin、无 Origin 脚本、错误/过期/旧进程凭据仍 fail closed。没有引入账号、租户或远程管理。
- 已删除模型密钥明文取回 API 及 Web 调用。配置文件只保存模型元数据；旧 JSON 明文密钥首次读取时先迁入宿主 Secret Store，再原子改写为无密钥文件。Desktop 使用 Electron `safeStorage`，Linux `basic_text` 后端直接拒绝；独立 Server 使用现有 AES-256-GCM SQLite Vault，也可由 `TRACEFORGE_LLM_API_KEY` 在内存中覆盖。UI 只能显示不可逆掩码，已保存密钥不能重新显示，只能替换。
- 生产 `main.ts` 已删除 `McpManager/loadMcpConfig/connectAll` 和关闭钩子，不再读取旧配置后直接 spawn；旧配置存在时只输出“已忽略、请走 Governed Provider/Profile”的诊断。`/api/mcp/tools` 旁路已删除，受治理 MCP Tool 与 MCP Context 的短集成测试共 32 项通过。
- Web Scenario 正式源码已删除手写 `definition.ts`、`package.ts`、`tools.ts`、`ports.ts`、Playwright/direct Browser 依赖和旧工具测试；包版本与唯一生产描述统一为 `0.3.0`。Kernel、Scheduler 与 Server 控制面测试都从真实 `scenario.json` 读取 Definition；Server 执行相关控制面使用明确无网络/无工具的 fixture，不再拿旧同进程实现冒充生产覆盖。边界脚本禁止这些文件、`createToolSources` 和 direct Browser 重新进入生产源码。
- 验证结果：Foundation 边界扫描通过（290 个生产源码文件）；Foundation/packages、Server Foundation、Desktop、Web 和 Web Scenario 构建通过；针对性 52 项通过；LLM Secret 16 项通过、真实模型 1 项按既定决定跳过；Host Control + Governed MCP Tool/Context 97 项通过。完整 `test:fast` 曾在受限测试环境运行，但大量需要监听 loopback/Unix socket 的既有用例统一因 `EPERM` 失败并按“跳过超长测试”决定中止，不能记录为全量通过。

当前剩余边界：尚未启动打包后的真实 Electron 做人工 UI 冒烟；真实模型、24/72 小时长稳仍暂缓。旧 `config/mcp.json` 仅诊断、不自动转换；后续若需要兼容迁移，应另做离线转换器，不得恢复直启。

归属：本机 Execution Node 的部署/发布验收，不是远程节点。

### 仓库实现完成记录（2026-09-03）

- Linux Desktop 正式发布收窄为 DEB，不再把无法安装宿主策略的 AppImage 列为受支持发行物。DEB 生命周期钩子安装 root-owned 固定 helper 与匹配 release manifest、加载固定路径 AppArmor Profile，并安装 `/usr/bin/traceforge` 本机启动器；不关闭全局 AppArmor/userns 防护。
- 启动器以当前登录用户进入 `Delegate=yes` 的瞬态 systemd user scope，把 Desktop 监督进程移入 `supervisor` 子 cgroup，在空的 scope 根启用 cpu/io/memory/pids controller，并只把该本机 scope 与 mode-0700 用户 scratch 交给 helper。没有创建远程节点、系统守护进程、产品账号或多用户平台能力。
- 安装/升级以固定权限原子替换 helper 与 manifest；Profile 或后续步骤失败时恢复上一代 helper、manifest、Profile 和 launcher。卸载只移除系统级执行资产，不删除用户数据。Desktop 直接启动或便携方式启动会明确返回 `linux_deployment_not_installed`，Sandboxed Process 关闭且没有 direct fallback。
- 新增跨平台仓库验收，检查脚本语法、可执行权限、DEB-only 发布配置、systemd delegation、四类 controller、固定 helper/manifest、AppArmor 安装/卸载和升级回滚接线；Linux 发布校验还会解开真实 DEB 的 control archive，检查 `postinst/postrm` 和随包部署资产。Server/Desktop 编译及本机生命周期 4 项测试通过。该结果只证明安装链代码闭合，不冒充 Linux 内核执行证明。

当前仅剩外部发布门槛：在全新 Ubuntu 24.04 x64 真机安装生成的 DEB，重跑 startup recovery/native probe、协议 2 的 19 类矩阵、卸载和失败升级回滚。没有真机期间冻结这项状态，不重复开发替代性远程节点。

若准备发布 Linux Desktop，则完整交付：安装包创建专用 systemd/cgroup v2 delegation、安装并加载 AppArmor Profile、配置受控 cgroup/scratch 根、执行 startup recovery 与 native probe，并把失败原因暴露为无秘密健康状态。安装、卸载和升级必须保持最小权限，不能要求用户全局关闭系统防护。

若暂时不交付上述安装链，则产品和文档必须明确标记 Linux Desktop 的 Sandboxed Process 为 experimental/不可用；helper 被打包不能作为 Process Ready 的证明。

验收条件：全新受支持 Linux x64 环境安装后可以通过协议 2 的 19 类原生矩阵；缺少 delegation、AppArmor、cgroup、helper measurement 或 probe 时进程能力关闭且无 direct fallback。

## 5. 第三整改批次：Runtime 下沉与 Web 构建结构

### 5.1 `apps/server` Runtime 职责下沉

归属：通用底座结构整改。

在开始 Code Audit Scenario 前，按真实依赖把 `run-planner.ts`、`run-observer.ts`、`structured-worker-model.ts`、`model-execution-runtime.ts`、`run-context-policy.ts` 和 `run-context-assembly.ts` 中不依赖 Fastify/SQLite/宿主配置的 Runtime 逻辑迁入 `agent-runtime`、`cognitive-runtime`、`model-runtime`、`scenario-runtime` 或 `worker-runtime`。Server 只保留 HTTP/WebSocket Route、SQLite Store/Adapter、配置读取和 Composition Root。

不为了目录对称机械拆包；只有能够形成稳定 Contract、独立测试且消除 Server 反向依赖的逻辑才迁移。

完成记录（2026-09-03）：上下文血缘纯投影与角色装配、Planner/Observer 的结构化决策和监督 Runtime、Structured Worker 的提示词/决策/上下文压缩/快照/授权复检都已迁入 `@traceforge/cognitive-runtime`；模型路由、Admission、预算、重试和熔断主体此前已迁入 `@traceforge/model-runtime`。原 Server 私有 `run-context-assembly.ts` 与 `structured-worker-model.ts` 已删除；Planner/Observer Server 文件只保留 SQLite Store 与 Fastify 查询路由，Context Policy 只采集 SQLite Tool Receipt、Package Context、Snapshot 和 derivation 事实。WorkerHost 的租约、工具副作用、Checkpoint 和控制面提交仍留在受控宿主，没有错误下沉到模型层。

### 5.2 Web Scenario TypeScript 模块化构建

归属：Web Scenario 工程结构整改。

把当前手写 `runtime/main.mjs` 拆成 TypeScript 源码模块，至少分离 RPC、工具注册、HTTP/Session/Traffic、Surface、URL/HTML/Discovery 与 Runtime 入口。构建产生受信、可复现的 `runtime/main.mjs` 发布物，描述文件继续固定其摘要；生产只执行构建产物，不在 Server 内编译或解释场景源码。

完成记录（2026-09-03）：`runtime-src` 已拆为合同、RPC、校验、HTTP/Session/Traffic 工具、Surface/HTML 和入口 6 个 TypeScript 模块；独立构建生成 6 个 `.mjs`，临时目录二次编译逐字节验证可复现性和入口依赖闭包。离线打包器自动把全部运行模块作为一个签名材料集合，真实 Server 装配测试同步覆盖依赖文件。4 项 Scenario Process、1 项真实 Package 装配和离线 Ed25519 打包通过。

验收条件：模块可以独立单测；构建结果确定；材料摘要覆盖最终产物；新增 Form/Auth/Browser/Validation 时不继续扩大单文件大单体。

## 6. 第四开发批次：Brokered Browser Runtime

归属：Web Scenario 使用的通用受控执行能力；Browser 页面/DOM/登录语义仍归 Web Scenario。

Browser Process 必须经本机 Execution Node 启动并通过强制代理进入授权网络 Broker。navigation、redirect、popup、iframe、fetch/XHR、WebSocket、download 和 Service Worker 流量都必须重新授权并留下归属/回执；不得恢复 Playwright `network: direct` 或任何临时直连版本。身份撤销、Scope/Run/lease 失效必须冻结 Browser Session；DOM、截图和下载以有界 Artifact 引用进入证据链。

完成记录（2026-09-04，Core/Host Controller）：新增无 Server/Scenario 依赖的 `@traceforge/browser-runtime`。Browser Process 只接受 sandboxed/brokered 调用权限，实际启动权限强制降为 OS `network=deny`；Controller 必须先证明 pipe、联网前拦截、Service Worker 禁用、下载和 WebSocket 拦截，验证后才开放回调。navigation、redirect、popup、iframe、fetch/XHR 和 download 逐请求复检所有权、重新授权并调用 Execution Node HTTP Broker；重定向不自动跟随，WebSocket 在流式 Broker 完成前阻断。下载必须写入 Artifact，Session 失效/超额会冻结终止，Snapshot 只保留 origin、URL 摘要及授权/回执/工件引用。Host 侧 Execution Node Controller 已实现审核身份/版本/SHA-256 握手、版本化有界帧、激活门禁、稳定写操作 ID、断线冻结和迟到响应隔离。沙箱内 Chromium/CDP 适配器、DOM/截图、人工接管恢复和真实原生平台断网证明尚未完成，因此 Composition 继续不注册 Browser Provider。

继续完成记录（2026-09-04，进程/CDP）：进程侧 Runtime 已接通相同 ready/activate/request/result/shutdown 帧；Chromium CDP 策略 Adapter 在释放脚本前为 page/popup/iframe/worker 安装 Fetch request-stage 拦截，关闭 Service Worker，禁止磁盘下载，保留 POST 原始字节，并且只注入 Host Broker 返回的响应。普通 document 的 attachment 响应也会先形成 Artifact；未关联 Artifact 的下载、正文缺失、帧损坏、超时或断线都会失败关闭。真实 Chromium FD pipe transport、浏览器子进程/发布装配、DOM/截图和人工接管恢复仍未完成，生产能力继续关闭。

继续完成记录（2026-09-04，pipe/发布身份）：新增真实 Chromium `--remote-debugging-pipe` FD 3/4 transport，完成 NUL 分帧、单消息/缓冲/在途命令/超时上限、启动和退出回收、固定安全参数与环境白名单、浏览器文件 SHA-256 和运行版本复核；禁止无沙箱、调试端口、代理和替换 profile 等旁路。严格发布清单同时绑定 Controller/Browser 文件名、版本、摘要、平台与架构，启动器必须复核两份安装材料后才能装配 pipe、CDP Adapter 与进程 Runtime。当前尚未构建真实 Controller bundle/受支持 Chromium 发行物，也未做真实浏览器和原生平台断网验收；DOM/截图/控制和人工接管恢复仍未完成，因此生产能力继续关闭。

继续完成记录（2026-09-04，页面交互/接管）：新增 Accessibility Tree DOM Artifact、视口 PNG Screenshot、DOM 差异摘要、页面/文档/代次绑定的 backend-node 引用，以及 navigation/click/editable-only fill/固定键动作。Controller 只接受最近 DOM 观察签发的元素，Host 二次核对正文摘要、长度、MIME、严格 DOM schema 和代次后才写 Artifact，Session 有界记录 Artifact、动作来源/输入摘要与控制权转换。人工接管拥有独立 takeover ID 和 manual observe/act 通道，但继续经过相同所有权、容量和 Network Broker；接管/恢复各换代一次，所有旧引用失效。新增严格 CLI/stdio Controller 入口和确定性单文件 Node 22 ESM bundle 构建检查。生产 Browser 仍关闭：真实 Chromium 集成、正式发行材料装配和原生断网真机证明尚未完成，本批未修改应用或 Scenario。

继续完成记录（2026-09-04，真实 Chromium/整树发行身份）：macOS arm64 的 Chrome 152 已真实跑通 pipe、navigation、302 redirect、popup、同进程 iframe、fetch/XHR、Artifact-backed download、DOM/截图/动作、人工接管恢复、renderer crash 通知及单文件 Controller 的 manifest/stdio/正常退出链；测试页面全部由内存 Broker 注入。真实浏览器揭示并修复同进程 iframe 误分类与 Controller shutdown 后 stdin 未销毁两项问题。发布清单升级为 v2，除启动文件外还度量完整 Chromium 安装树的文件内容、权限、目录和根内相对软链接；原子装配复制前后必须同摘要且拒绝覆盖已有目标。开发机 Chrome 不是正式可再分发材料，Linux/Windows 原生 `network=deny` 证明仍待真机，因此生产能力继续关闭；本批未修改应用或 Scenario。

继续完成记录（2026-09-04，来源锁/安全解压/安装门禁）：新增严格 Source Lock，固定来源身份、版本、revision、平台/架构、HTTPS URL、ZIP 字节数与 SHA-256、唯一根目录、相对启动文件以及安全/许可证评审引用。发布装配不再接受任意已解压目录，而是对同一只读文件句柄在解压前后验真，流式限制条目、单文件与总展开量，并拒绝加密项、路径穿越、重复路径、特殊文件、逃逸软链接及链接下内容；失败会清除半成品且不覆盖既有目标。v3 release manifest 记录来源锁摘要和归档身份，发布目录同时包含 `source-lock.json`；Controller CLI 启动时再次核对可信来源锁、来源溯源、平台/架构、完整树、浏览器启动文件和 Controller。14 文件/56 项短回归、1 文件/2 项真实 macOS Chrome 集成、78,996 字节可复现 bundle、16 packages/Server 编译和 306 源码门禁通过；完整 Foundation 矩阵另有 92 文件/1,465 项、8 文件/62 项及 15 文件/90 项全部通过。本批没有把 Chrome for Testing 或开发机 Chrome 直接认定为正式产品来源；各平台安全/许可证审核和 Linux/Windows 原生断网证明仍是生产门槛，未修改应用或 Scenario。

继续完成记录（2026-09-04，来源评审权威与生产路线收敛）：Source Lock 不再仅凭本机路径获得信任。新增 Ed25519 Source Review 与外部 Authority 严格合同，精确绑定 Lock 摘要、key ID、允许的 source ID、签发/过期窗口和撤销时间；未知/越权/未来/过期/撤销 key、非规范签名或材料换代全部 fail closed。v3 manifest 继续钉住 Review 摘要和到期时间，原子 release tree 携带 Review 但不携带可自我背书的 Authority；Controller CLI 从外部可信路径读取 Authority，每次启动重新验签。官方资料核对后明确不把仅限可信内容的 Chrome for Testing、best-effort/任意 revision 的 Chromium snapshot、自动更新 Chrome 或未经审核第三方包当作生产来源；候选路线收敛为固定官方 Chromium commit 和完整工具链后自建无品牌产物。15 文件/58 项 Browser 短回归、1 文件/2 项真实 macOS Chrome 集成、87,335 字节可复现 bundle 和 307 源码门禁通过。本批仍没有批准任何真实发行版本，也未修改应用或 Scenario。

验收条件：受测 Browser 无法绕过代理直连；跨目标和重定向逐次授权；会话秘密不进入模型或日志；人工接管和进程恢复不重放未知副作用。

## 7. 第五验收批次：最小 Code Audit Scenario

归属：第二个独立 Scenario，仅用于验证底座通用性，不是完整白盒产品开发。

建立最小签名数据 Package：接受已授权 Repository 资源，通过受控能力列文件和读取源码，形成独立 Hypothesis、Evidence 与受生命周期约束的 Finding。它必须复用现有 Package、Skill、Knowledge、Provider、State、Artifact、Evidence 和执行合同。

验收条件：不得修改 `orchestration-core` 增加 code-audit 特判，不得新增固定 WorkerRole/WorkKind，不得在 Server 中注册场景工具或代码分析语义。若只有新 Package 与必要的通用能力声明即可运行，Scenario Extraction 才算由第二类场景验证。

## 8. 后续执行顺序

1. ~~先一次性完成第 3 节三个 P0，并同步删除旧路径、补回归和更新计划。~~ 已完成。
2. ~~完成第 5.2 节 Web TypeScript 模块化，并完成第 5.1 节上下文血缘/装配的首个下沉切片。~~ 已完成；第 4 节只等待 Linux 真机终验。
3. ~~完成第 5.1 节 Structured Worker 提取和认知模型层收口。~~ 已完成。
4. 当前下一步：为第 6 节候选路线建立官方 Chromium 源码 commit、`depot_tools`/依赖解析、GN 参数、构建环境、SBOM/NOTICE 与双构建摘要合同；随后用真实构建产物生成各平台 Source Lock/Review 和产品 release tree。原生断网终验证在对应 Linux/Windows 真机可用后执行，不恢复任何 direct Browser 临时路径。
5. 用第 7 节最小 Code Audit Scenario 验证通用性。

三个 P0 已完成并由边界门禁固定；后续不得恢复旧旁路或双实现，也不得用新增功能绕过现有授权、沙箱、审计与证据链。每个代码批次都必须同步 `docs/development-status-and-roadmap.md`，记录真实完成项、剩余风险、验收结果和下一明确优先级。
