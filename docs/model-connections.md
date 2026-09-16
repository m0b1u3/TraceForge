# TraceForge 上游模型接入

## 2026-09-16 当前状态（覆盖下方历史批次的待办描述）

继续独立实现，不依赖或运行 Pi、CC Switch。现有桌面配置、账号登录、动态模型目录与三协议适配已经装配；供应商预设扩展为 20 个供应商/区域/套餐入口。完整清单及最新测试结论以 [开发计划](development-status-and-roadmap.md) 顶部记录为准，预设不代表所有供应商实测通过。

客户端“推理与兼容参数”可修改思考模式、推理强度、温度和 Responses 加密续接请求。参数按协议适用：Messages 不发送 reasoningEffort，Responses 不发送 thinking；Messages 开启思考目前使用 adaptive，不保证所有兼容型号支持。三协议工具循环保存同连接的私有续接数据，跨模型/端点/账号不回传；不把签名或加密数据显示成公开思考。正式桌面已增加完成回复的加密缓存，可在下一回复或宿主重启后恢复；缓存校验与容量限制见下文，不承诺恢复未完成派发或供应商已失效状态。

开发者真实验收入口 `scripts/verify-model-connection.mts --allow-model-api` 从标准输入接收临时连接 JSON；交互终端须先关闭输入回显，不将密钥放入命令参数、文件或报告，不覆盖桌面现有账号。真实调用必须事先得到用户同意。全批限制最多 100 次物理模型 POST（包含适配器重试），最长 60 分钟；依次覆盖流式停止/重开、滚动摘要和同一桌面会话的额外 24 轮原文回读。达到上限即停止，不以跑满次数作为通过标准。报告位于被忽略的 `data/desktop-model-acceptance`；记录未上报用量的调用，已上报 token 总数不是保证完整的账单。该入口是开发验收设施，不是普通用户需要手动编辑配置的日常流程。

当前实施以 [独立模型网关计划](model-gateway-plan.md) 为准：多供应商、多协议及账号连接是同一开发任务，不以 API Key 表单替代。2026-09-06 新增 Responses 适配和可注入 ModelGateway；供应商预设与协议独立，桌面可选择 Responses，账号注册与登录界面仍待装配。

## 范围与边界

本模块只服务 TraceForge，不管理 Claude Code、Codex、Gemini CLI 等客户端，不修改它们的配置文件，不读取 CC Switch 或 Grok CLI 的账号文件，不需要安装本机转发代理。

依赖方向：TraceForge 的 Model Runtime → `LlmProvider` → `packages/llm` 的供应商元数据、协议适配与认证传输 → 上游服务。Scenario 不引用厂商/账号；Core 不包含厂商常量。角色路由、预算、并发、重试和熔断沿用现有 Model Runtime，不在接入层复制调度器。

## 已实现

- `supplier` 是可选的供应商预设，和 `provider` 的协议类型分开。DeepSeek、xAI、Kimi 国内、GLM 国内有 API 地址及 JSON 模式预设，模型 ID 由安装者显式提供；预设不声称所有型号均已验证。自定义地址可覆盖默认值，其他兼容供应商不必新增 Core 枚举。
- `requestOptions` 显式配置 `thinking`、`reasoningEffort`、`temperature`，并传递现有 `maxOutputTokens`。选项不根据模型名猜测；当前这些选项作用于 Chat Completions 适配器，各厂商支持范围须按具体型号验证。Anthropic 原有参数行为未在本批改造。
- API Key 沿用应用宿主秘密存储；连接元数据与掩码不包含密钥。换 API 端点不会隐式继承旧端点的密钥。
- `credentialRef` 与直接 API Key 互斥。宿主通过 `ModelCredentialResolver` 按请求提供有端点归属和有效期的凭据，支持受管 token 更新，不在模型消息中传递。没有 resolver 时拒绝启动该连接，而不是当作普通 key 猜测使用。
- 所有 factory 创建的 Provider 使用受约束传输：HTTPS 或显式 loopback HTTP、无 URL 内凭据/查询参数、目标须留在配置的 origin/path 内，不跟随重定向。Anthropic 的 `authMode: bearer` 是显式配置，默认仍为 API Key。
- `/api/config/llm/suppliers` 返回非秘密预设目录，沿用已有应用控制通道权限，不新增对其他工具提供服务的网关监听端口。

API 配置示例（密钥通过现有配置保存接口进入秘密存储，不写进此文件）：

```json
{
  "provider": "openai",
  "supplier": "deepseek",
  "model": "由安装者填写的准确模型ID",
  "jsonMode": "json_object",
  "requestOptions": { "thinking": "disabled" },
  "maxOutputTokens": 8192
}
```

上述模型 ID 是说明性占位值，不是可用型号；不要直接用示例发起请求。角色选模仍通过既有 `alternativeRoutes` / `rolePolicies` 配置，不需要为 Scenario 定制模型分支。

## 订阅 / OAuth：已实现与未接通必须分开

`DeviceAuthorizationConnection` 实现可测试的通用设备码登录、单次有界轮询、pending/slow_down/拒绝/过期处理、取消、token 轮换、并发刷新合并及本地断开。设备码留在模块内部，对 UI 只返回随机 pending ID、用户码与验证地址。发现文档 issuer 和端点 origin 必须匹配部署批准的注册；响应有时限/字节上限，不向调用者回传上游错误正文。Token 绑定 issuer/client/scopes/API endpoint，不能跨连接复用。

宿主必须注入 `OAuthTokenStore` 的安全存储实现和经过确认的 `OAuthConnection` 注册；模块没有文件存储或硬编码第三方 CLI client ID。`disconnect` 只删除本产品的凭据并阻止旧刷新结果恢复连接，不代表已调用厂商远端撤销接口。

**2026-09-07：settings-only 桌面已提供 Grok 兼容登录入口，等待用户手动授权验收。** 宿主默认预设使用官方源码公开的客户端标识，不是 TraceForge 自有注册或套餐权限保证；显式安装清单可覆盖预设。Responses 子集通过测试不代表全部转换和账号权限已验收，不能用 API Key 测试或伪造 token 替代。详情见 [账号注册说明](model-account-registration.md)。

## 参考材料

参考 CC Switch 的 [ProviderAdapter 分层](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/adapter.rs) 和 [供应商/协议分类](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/mod.rs)，采用元数据、认证、协议分离，不引入其客户端管理、配置接管、代理监听或数据库结构。

核对其 [xAI OAuth 实现](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/xai_oauth_auth.rs) 后，参考设备授权、刷新合并和失效处理的设计；兼容预设采用同一公开客户端标识，没有复制账号文件或源代码。上游 main 为可变参考，本文不是固定 commit 的第三方供应链归档。后续若实际引入代码/依赖，须单独核实版本和许可证。

## 当前桌面模型配置入口（2026-09-06）

运行 `pnpm --filter @traceforge/desktop dev:models` 打开独立模型配置窗口。支持供应商预设/自定义地址、接口协议、模型 ID、API 密钥、高级参数、读取、测试与保存。测试可能产生 API 费用且不会保存；保存影响宿主后续调用。密钥不回显、不写浏览器存储，通过宿主 safeStorage 加密保存。浏览器预览不是密钥设置入口；正式桌面调查功能仍受启动围栏保护。

已通过受控接口/存储/表单回归和 Electron 打开读取检查，尚未用真实供应商凭据验收。API Key 接入不等于支持聊天套餐登录。当前继续独立模型网关与账号装配开发，具体优先级见模型网关计划。

## 后续受支持账号连接目标

只面向 TraceForge，继续独立安装环境下的登录→续期→模型调用→退出验收。现有公开客户端兼容模式必须明确标注，不宣称自有注册；供应商拒绝权限时如实反馈，不绕过限制。真实密钥与账号验收由安装者授权，测试不读开发者个人配置。
# 模型能力与自动预算补充（2026-09-15）

## 多模态输入

模型层与桌面已接通 PNG/JPEG、PDF 和 UTF-8 文本；WAV/MP3 输入限 Chat Completions。模型设置分别提供图片、PDF、音频能力声明，非文本输入需明确支持，未知不会猜测。声明不能绕过协议限制。视频、实时语音、媒体生成、Office 转换未接通。

使用“添加附件”选择文件。正式桌面由宿主读取：PDF / UTF-8 文本每份最多 32 MiB，以本地引用随消息保存；模型先拿到未读取声明，再按需读取。图片 / 音频每份仍最多 1 MiB，所有附件最多 4 份、消息内序列化总量 2.8 MB。未发送附件离开界面不保证保留；待核对发送命令沿用原编号和原附件。无宿主的浏览器预览只支持原有小附件输入（文本最多 64000 字符）。

较早附件通过 `conversation_attachments` 查找，再用 `conversation_attachment_read` 读取。PDF 传 `startPage/endPage`，页码从 1 开始、包含两端、每次最多 8 页，存储型 PDF 不传范围默认读第 1 页；大文本传 `offset` 并跟随 `nextOffset`，每次最多 16000 个 UTF-16 字符。宿主检查归属、摘要哈希、模型能力和预算后，将选定内容作为资料送入下一轮。同次回复相同页段不重复装入。抽页后的 PDF 超过 1 MiB、加密/损坏文件、越界均返回明确错误，不自动上传整份。图片/音频仍整份读取；没有 OCR 全文检索或音视频切片。工具的 loaded 仅表示原件装入请求，不代表模型已成功理解。

## 私有续接状态

正式桌面把已完成回复的供应商续接块及配套工具结果加密缓存；新回复和重启后的新回复可恢复到请求历史。仅适用于相同协议、型号、端点与账号绑定；签名/加密块不改写、不显示在 renderer、不作为摘要内容。正文和供应商公开输出的思考仍按原有显示规则处理。

缓存损坏、无法解密、原文链变化、模型输入能力不兼容或状态已被容量淘汰时，使用普通保存答复。系统安全存储不可用时不写明文缓存。单条 4 MiB、总量 32 MiB；近期窗口以外的状态不强行塞回上下文。恢复不会重发中断请求或重放工具；厂商拒绝过期状态时如实返回错误，不把拒绝解释为继续执行权限。跨厂商续接、无限思考记忆不是已实现承诺。

桌面“模型能力与自动预算”折叠区可查看目录声明、手动覆盖、采用本次目录声明或清除声明。未知不代表不支持；普通 OpenAI 模型目录只返回 ID 时不会猜测能力。官方 DeepSeek Flash 的精确端点有独立、可覆盖的文档默认值，代理端点不继承。

选择型号后保存声明，运行时才消费；刷新目录不修改已保存配置。高级参数的手动窗口/输出预算优先，清空恢复自动预算。默认输出为窗口八分之一、4096 和声明输出上限中的最小值，不直接申请模型最大输出。声明不支持的工具/推理会拒绝调用，不扩大任务授权。更换连接身份清除旧声明；已开始的对话生成保留配置快照。
