# TraceForge 上游模型接入

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
