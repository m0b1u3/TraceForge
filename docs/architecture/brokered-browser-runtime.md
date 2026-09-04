# Brokered Browser Runtime 安全边界

本文记录 `@traceforge/browser-runtime` 的底座职责和当前完成边界。Browser Runtime 是通用执行能力，
不理解站点、登录方式、漏洞类型、Payload 或任何具体 Scenario 语义。

## 已建立的执行链

```text
Scenario/Tool 请求浏览器能力
        ↓（可信 Case/Run/Work/Worker/Scope/lease）
BrokeredBrowserRuntime
        ├─ 本机 Execution Node 启动 Browser Process
        │      └─ OS 沙箱证明 network=deny
        ├─ pipe 控制器证明全部请求在联网前暂停
        └─ 每个 HTTP(S) 请求重新授权
               ↓
          ExecutionNode.requestHttp
               ↓
          手动重定向响应 + Network Receipt
```

- 调用方必须具有 `sandboxed` 进程权限和 `brokered` 网络权限。Runtime 启动浏览器时把进程网络强制降为
  `deny`，因此浏览器本身没有直连、系统代理或环境代理退路；宿主代发请求使用单独复制的
  `brokered` 权限，不能被浏览器进程取得。
- 启动回执必须逐项匹配可信归属、可执行程序、参数、工作目录、权限/资源指纹、非终端运行状态，以及配置固定时的
  sandbox backend 和 helper measurement；不能拿另一个已沙箱化进程的证明冒充当前 Browser Process。
- 控制器必须先给出 pipe、联网前拦截、OS 断网、Service Worker 禁用、下载拦截和 WebSocket
  拦截/阻断证明；Runtime 验证后才注册请求回调并允许控制器开始工作。证明不完整或初始化失败会终止浏览器进程。
- Host 侧 `ExecutionNodeBrowserController` 已通过 Execution Node 的 stdin/stdout 建立有界长度帧协议：先核对审核时固定的
  Controller/Browser 版本与 SHA-256，再发送 activation；Controller 在 activation 前发请求、丢失事件字节、输出截断、
  返回未知响应、超过容量或进程退出都会触发 Session 冻结。每条写入都有稳定操作 ID，旧进程失败后的迟到结果不会再写回。
- 进程侧 `BrowserControllerProcessRuntime` 已实现同一协议的另一端；`ChromiumCdpAdapter` 在激活前设置 Target auto-attach、
  `waitForDebuggerOnStart`、HTTP(S) `Fetch` request-stage 拦截、全局禁止磁盘下载，并对新 page/popup/iframe/worker 逐一安装拦截后才释放脚本。
  Service Worker 会在释放前关闭，未知 target 会 detach；请求正文优先读取 CDP 的原始 base64 entries，正文不可取得时直接失败。
- `ChromiumPipeTransport` 已把 Adapter 接到 Chromium 的 `--remote-debugging-pipe`：Node 子进程只开放 FD 3/4 控制通道，
  CDP 使用 NUL 分帧并限制单消息、总缓冲、在途命令、启动/命令/退出时间。启动参数和环境采用固定白名单，拒绝 `--no-sandbox`、
  调试端口、代理、替换 user-data-dir 及环境代理；浏览器启动文件 SHA-256、完整安装目录树 SHA-256 和 `Browser.getVersion` 必须与审核身份一致。异常 stderr 只报告被扣留字节数，
  不把可能含秘密的原文带回 Host；退出超时会强杀子进程。
- v3 发布身份合同从构建来源开始钉住整条链：Build Attestation 固定 Chromium 官方 Git commit、`depot_tools`/依赖/GN/构建配方摘要、
  SBOM/NOTICE、安全/许可证评估、目标平台签名身份和至少两次独立同树复现；严格 Source Lock 再固定 Attestation 摘要、来源身份、版本、commit、
  平台/架构、HTTPS URL、压缩包字节数/SHA-256、唯一根目录、相对启动路径以及安全/许可证评审摘要。装配器只接受锁定的 ZIP，并通过同一只读
  文件句柄在解压前后复核摘要；流式解压限制条目、
  单文件和总展开容量，拒绝加密项、绝对/逃逸/重复路径、特殊文件、逃逸软链接和软链接下内容。随后原子发布 Controller、完整 Browser tree、
  `source-lock.json`、`source-review.json`、`build-attestation.json` 与严格 release manifest，实测完整树必须与复现构建证明一致。Source Review 使用离线 Ed25519 密钥签署精确 Lock 摘要，并受 Authority 的 key ID、
  source ID 范围、有效期和撤销时间约束；Authority 从 release tree 外部注入，归档不能自带公钥给自己背书。目录度量继续覆盖普通文件内容、权限位、
  目录和限制在根内的相对软链接；Controller 启动时同时读取 Source Lock、Review、Build Attestation、外部 Authority 和 release manifest，只有评审当前有效且来源溯源、
  平台/架构、完整树、启动文件和 Controller 全部一致才装配正式链。
- Host 返回的 Broker directive 只能通过 `Fetch.fulfillRequest` 注入；拒绝则使用 `BlockedByClient`。Chromium 报告下载时必须能对应到
  已经形成 Artifact 的响应，否则 Controller 进程失败。Host/进程任一侧帧错误、超时或断线都会关闭 CDP 并以失败状态退出。
- navigation、redirect、popup、iframe、fetch、XHR、download 和其他 HTTP(S) 请求都进入同一个有界入口。
  重定向由 Execution Node 以 `redirectFollowed=false` 返回，浏览器产生的新请求必须再次进入授权，不能沿用上一跳授权。
- 每次请求前后都复检 Session 所属的 Case、Run、Work、Worker、Scope 和 lease。网络效果发生后若所有权失效，
  响应不会交给浏览器，Session 会冻结并终止进程。
- 请求采用稳定 ID 和规范指纹。已完成请求可以安全 replay；同一 ID 换输入或发生了效果却没有形成终态时会拒绝，
  避免重启或控制器重试造成未知重复效果。
- Session、并发、请求数、请求/响应正文、头数量和超时都有硬上限。Snapshot 不保存请求/响应正文，也不保存可能
  带 Token 的完整 URL，只保留 origin、URL 摘要、授权引用、Network Receipt 引用和 Artifact 引用。
- download 正文只有成功写入宿主 Artifact 端口后才能返回引用；缺少 Artifact 端口时保持未知围栏，不能把下载正文直接塞进模型上下文。
- 页面观察由 Controller 使用 Accessibility Tree 和视口截图产生。DOM Artifact 只保留有界 role/name/description/状态，主动省略表单 value；
  screenshot 只允许 PNG、限制宽高/像素/字节。Host 会重新核对 base64、长度、SHA-256、MIME、DOM 严格结构、页面代次和文档身份，
  通过后才调用 Artifact 端口；返回调用方的结果不含正文，只含 Artifact 引用和差异摘要。
- 可操作元素引用由 `generation + pageId + documentId + backendNodeId` 组成，而且 Controller 只接受最近一次 DOM 观察实际签发的引用；
  模型猜测 backend node、页面导航后沿用旧引用、人工接管后沿用旧代次都会拒绝。控制动作目前限定为绑定当前 view 的 navigation、
  已签发元素的 click/fill 和固定键集合，不执行任意页面 JavaScript；fill 仅允许最近观察中标记为 editable 的元素。
- 人工接管不是放开浏览器直连。Host 进入 `manual_control` 后暂停 Agent 观察/动作，人工通道必须携带 takeover ID，继续复用同一套
  DOM/截图、元素引用、动作上限、所有权复检和 Network Broker。接管与恢复各旋转一次 generation；恢复后的 Agent 必须重新观察，
  旧 Agent/人工引用全部失效。Session 快照有界记录 Observation Artifact、动作来源/输入摘要和控制权转换，不保存页面正文或输入明文。
- WebSocket 当前在逐次授权后明确阻断，因为普通 HTTP Broker 不能证明双向长连接每一帧的容量、生命周期和撤销语义。
  Service Worker 当前要求控制器禁用。两者不会以“先直连、以后再补”的方式开放。

## 失败与关闭语义

Session 到期、请求预算耗尽或所有权复检失败都会冻结控制器并强制结束浏览器进程。主动关闭、重复关闭和冻结后的清理
保持幂等；即使控制器关闭报错，Runtime 仍会继续终止 OS 进程。控制器返回的响应还必须与可信归属、授权动作、
Host Broker 权限指纹、URL、方法、正文长度和手动重定向事实一致，否则不交付给浏览器。

## 尚未完成、因此生产能力仍关闭

当前完成的是无 Scenario 依赖的 Browser Runtime 核心合同、状态机、Execution Node/Broker/Artifact 连接、Host/进程双向控制协议、
Chromium CDP 策略、真实 FD 3/4 pipe、构建证明/来源锁/离线评审签名/安全解压/v3 整树发布身份/本机安装门禁、有界页面观察/控制、人工接管恢复和失败关闭。Controller 已提供严格 CLI/stdio 入口，
可确定性构建为单文件 Node 22 ESM bundle。macOS arm64 的真实 Chrome 152 已跑通 navigation、redirect、popup、同进程 iframe、fetch/XHR、download、
DOM/截图/动作、人工接管恢复、renderer crash 通知及 bundle 正常关闭；真实测试页面完全由内存 Broker 注入，没有访问外部目标。仍缺少：

- 在实际构建环境用固定官方 Chromium commit 和工具链执行至少两次独立构建，生成真实 SBOM/NOTICE、安全/许可证评估、平台签名、稳定 URL、
  字节数和摘要，再签发产品 Source Lock/Review 与 release tree；当前通过的是证明/安装/评审合同和开发机现有 Chrome 测试夹具，不是可再分发材料；
- 应用阶段的人机交互界面；底座人工通道和恢复围栏已完成，但本批没有修改应用层；
- Linux/Windows 原生沙箱上的真实“不经过 Host Broker 无法联网”证明。

来源选择不能只看“版本可固定”。[Chrome for Testing 官方说明](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)
虽然提供按版本下载和[平台 JSON 端点](https://github.com/GoogleChromeLabs/chrome-for-testing#json-api-endpoints)，但其用途说明要求只处理可信内容；TraceForge Browser
会接触潜在恶意目标，因此当前只把它视为自动化测试候选，不自动写入生产 Source Lock。正式来源必须另行完成安全维护、再分发许可证和恶意内容处理边界审核。
完整来源决定、候选生产路线和所需材料见 [Browser Runtime 发行来源策略](browser-runtime-source-policy.md)。

这些门槛完成前，Composition 不注册 Browser Provider，Web Scenario 也不获得 Browser 能力。下一批不再扩张底座证明合同，而是在可用构建环境上
执行首个官方 Chromium 固定 commit 的双构建、SBOM/NOTICE 与评估材料流水线；原生 OS 断网证明在对应 Linux/Windows 真机可用后补齐。
Scenario 适配仍在底座能力通过发布门槛之后单独进行。
