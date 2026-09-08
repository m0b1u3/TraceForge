# Desktop 本地证据正文阅读器

## 范围与权限

阅读器为操作者提供不可变本地 Browser artifact 的历史审计正文。会话中的引用和任务／证据面板共用同一阅读组件，按需展开，默认不读取正文。它是现有白色／slate Operate/Read 界面的延伸：用户消息在右，智能体回复在左，正文留在引用所在的阅读上下文中。

操作者的历史审计读取与 Agent 的 active scope grant 是不同能力。读取不会授予 Agent 新的目标访问权限，不会重新执行原操作，也不改变 Run 操作、生命周期或模型行为。正文是「不可信观察」；摘要核对证明内容身份与完整性，不证明安全发现已经验证。

此版本仅支持已绑定到本地 Browser 内容存储的 artifact，不是通用 artifact 查看器。未知引用或无可读本地正文的引用显示不可用；没有外部 URL 访问、文件路径推测、原生文件打开器或导出功能。

## 来源与完整性检查

桌面 conversation bridge 仅允许固定的 `POST /api/desktop/conversations/:conversationId/evidence/read` 路由。请求体上限为 2048 字节，经严格 schema 校验，只接受 `runId`、`ref`、`offset` 和可选 `expectedDigest`。现有 bridge 的本地主窗口来源检查与并发限制继续适用；该接口不是任意 HTTP 代理。

服务端从 conversation 记录解析所属 case，renderer 不能提交 case 或 package 身份。查询同时要求 artifact 的 case、请求的 run、artifact ID 或 content reference 匹配，并通过 `browser_content_bindings` 与同 case、同 run 的 `browser_artifact_content` 关联。引用仅作为数据库查找键，不转为 URL 或文件路径。

每次读取都检查完整正文的 Buffer 类型、长度、artifact 记录的字节数，以及正文 SHA-256、artifact digest 和内容存储 digest 的一致性。后续页还必须匹配首个回执的 `expectedDigest`。缺失的会话或正文返回不可用；完整性或偏移检查失败返回不可读，不尝试回退到其他内容来源。

renderer 校验回执 schema、引用、run、偏移、artifact 身份、digest、总长度和格式。它还核对 Base64 编码、分页长度与连续性，最后一页到达后对累积全文重新计算 SHA-256。部分文本明确标记为尚未完成全文核对。

## 分页与呈现

正文总量上限为 4 MiB，每页最多 64 KiB，最多 64 页。文本通过「继续读取正文」逐页累积；UTF-8 跨页时暂不显示尾部不完整字符。文本在普通预格式文本元素中呈现，包括 HTML 和 SVG，均不作为标记、脚本或指令执行。

PNG 预览先检查签名与 IHDR 尺寸：宽高均须为正且不超过 8192，总像素不超过 16,777,216。组件自动读取其剩余页，全文 SHA-256 核对成功后才生成本地 PNG data URL。此检查不是完整 PNG 解码验证；图片解码失败会显示错误。

其他二进制内容仅显示已读取内容中前 256 字节的十六进制预览，不作为文档或程序打开。多页二进制的预览不宣称已完成 renderer 全文核对，也没有继续读取按钮。

## 交互与视觉约束

引用按钮以方向箭头和「查看正文／收起正文」表达展开状态，并提供 `aria-expanded`。展开后显示本地审计说明、摘要、读取字节进度、完整性状态与 digest；加载状态使用 status，错误使用 alert，并提供重新读取入口。收起时释放当前显示内容并取消当前读取流程；异步结果在取消后不更新显示。

正文延续现有中性色、系统字体与焦点样式，使用浅灰文本底面和受限高度的滚动区域。长引用、digest 和文本可换行；PNG 在容器内等比适配。此处记录的是证据阅读表面的实现约束，不新增全局视觉系统或改变会话的主工作流。

## 实现入口

- `packages/shared/src/desktop-evidence.ts`：请求、回执和容量约束。
- `apps/server/src/desktop-evidence.ts`：conversation 所属关系、本地绑定查询与完整性检查。
- `apps/desktop/src/conversation-bridge.ts`：桌面读取路由白名单。
- `apps/web/renderer/evidence-client.ts`：分页校验、累积与全文摘要检查。
- `apps/web/renderer/evidence-reference.tsx`：按需正文、惰性披露和安全呈现。
- `apps/web/renderer/conversation-execution.tsx`、`execution-panel.tsx`：会话及任务／证据入口。
- `apps/web/renderer/workbench.css`：阅读器与现有白色／slate 布局的视觉衔接。
