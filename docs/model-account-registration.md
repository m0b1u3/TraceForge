# 安装级模型账号注册

此文描述已实现的 settings-only 桌面装配，不表示 Grok 套餐已验收。

2026-09-07 实测补充：用户已成功登录 Grok；设置窗口重启后恢复登录并自动取得 12 个模型。模型 ID 可从目录选择，不再要求手填。一个已登录账号且尚无保存配置时自动带入该账号，否则保留已有配置；多账号不擅自切换。读取目录不发送对话或生成请求，页面不自动选择/保存/测试型号。目录失败可刷新或手动输入，上游列表不完整会提示。用户已在页面选择 grok-4.6 并保存；实际生成、工具能力与续期仍待验收。

在 Electron userData 的 `config/model-accounts.json` 中安装宿主注册；文件不是 token 存储，不接受 renderer 动态提交。更改后重启设置窗口。文件不存在时使用 Grok 兼容预设；显式清单完整覆盖默认项，包括空账号列表。

结构示例（所有地址和 clientId 都是说明性占位值，不能直接用于登录）：

```json
{
  "version": 1,
  "accounts": [{
    "id": "primary-account",
    "label": "我的模型账号",
    "provider": "responses",
    "registration": {
      "issuer": "https://identity.example",
      "clientId": "installation-approved-client",
      "scopes": ["api"],
      "apiBaseUrl": "https://model.example/v1"
    }
  }]
}
```

`provider` 是协议，可为 openai、anthropic、responses。每个账号引用绑定一份注册；不能用同一个引用静默切换授权方或 API 地址。账号与 API Key 不能同时配置，账号模型调用使用 Bearer。新增供应商不改 Core/Scenario。

操作：运行 `pnpm --filter @traceforge/desktop dev:models`，选择 Grok 兼容账号并登录，点击“打开授权网页”，或手动打开显示的 HTTPS 地址输入验证码。页面默认自动检查结果，可关闭自动检查并手动点击“检查登录”。随后在模型表单选择认证连接、填写模型 ID，测试后保存。测试可能产生 API 费用。登录仅确认令牌获取，不证明套餐或模型能力。

退出需确认，仅移除本安装的 token；使用该账号的配置仍保留但不能继续调用。当前窗口关闭后不恢复未完成登录，重新登录会替换该连接旧的待授权流程。已完成登录凭据加密持久化，后续调用可按有效期刷新。刷新 invalid_grant 时清除失效记录以要求重新登录。

安全存储路径为同目录 `model-tokens.bin`，加密实现由 Electron safeStorage 提供。不可用或 Linux basic_text 后端时拒绝秘密存储；损坏文件失败关闭，不以空文件覆盖。不同安装不读取 CC Switch、Grok CLI 或其他客户端账号文件。

## Grok 的剩余事实核实

已读取的 [Grok 官方部署说明](https://docs.x.ai/build/enterprise) 区分账号推理代理 `cli-chat-proxy.grok.com` 与 API Key 直连 `api.x.ai`，并描述设备码/OIDC 登录。这不是 TraceForge 可复用其官方 client ID、套餐权限或代理协议的证明。CC Switch 的另一种装配也不能自动等同于当前官方 CLI 合同。

2026-09-07：核对 [官方 Grok 配置源码](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/auth/config.rs)、[CC Switch 授权实现](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/xai_oauth_auth.rs) 和 [OpenCode xAI 插件](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/xai.ts)，提供公开客户端兼容预设：issuer 为 auth.x.ai，公开 client ID 为 b1a00492-073a-47ea-816f-4c329264a828，推理端点 api.x.ai/v1，协议 Responses。不是 TraceForge 自有注册，也不构成第三方复用许可或套餐可用性保证；供应商可能改变或拒绝此兼容入口。发行前还需核实适用条件。

验证地址另允许 accounts.x.ai；缺省 token_type 按 Bearer、缺省 expires_in 按 3600 秒处理，仅限明确配置的注册。模型 ID 必须由用户确认，不猜测套餐可用型号。测试全部使用受控授权服务与模拟凭据，不使用开发者本地账号，不声称真实 SuperGrok 已验收。
