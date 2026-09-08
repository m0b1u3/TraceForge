# 桌面会话保存合同（2026-09-06）

这是应用层持久化合同，不是第二套 Agent Runtime。生产注册沿用 registerRoutes 与 FoundationHostControl，所有 /api/desktop 入口只允许已有本机管理通道；Worker 不获得管理权限。

| 入口 | 语义 |
| --- | --- |
| POST /api/desktop/conversations | commandId、title；事务创建会话及空 scope 的 Case。首次 201，同内容重放 200，不同标题复用命令 409，原 Case 丢失 410 |
| GET /api/desktop/conversations | 返回仍有归属 Case 的会话，最多 1000 条（也是创建容量上限） |
| GET /api/desktop/conversations/:conversationId | 读取当前会话归属；不存在或原 Case 丢失 404 |
| POST /api/desktop/conversations/:conversationId/messages | commandId、text；首次 201，原内容重放 200，内容冲突 409 |
| GET /api/desktop/conversations/:conversationId/messages | after 为本会话上次 sequence，limit 1–100；messages / nextAfter / hasMore。不是 Agent 事件游标 |

消息回执固定 role=user、persistence=saved、delivery=not_dispatched、reason=conversation_dispatch_not_connected。它只证明文本入库，不能画成模型已接受/已回答。尚不允许伪造 assistant 消息、附带审批、Run 或 scope。正文按原始文本保存，客户端纯文本渲染；不应输入密钥。SQLite 文件不是凭据加密库。

桌面桥实现增量：preload 提供 conversations.protocolVersion=1/request，main 以原管理通道调用上述接口；只允许自身主框架的精确 origin/root 和限定会话路径。HostWorkbench 已消费桥，没有桥时使用独立演示，不在连接失败时伪造示例。正式桌面围栏尚未解除，因此此为已编译/受控测试的接线，不是 Electron 实机验收。IPC 前本地日志保留稳定命令及正文，成功回执后清除；存储失败不派发，不存管理凭据。

创建和追加采用稳定命令 ID。网络失败、成功响应正文损坏、服务端 5xx 均不能证明未写入；使用原 ID 和原内容重试对账，禁止换新 ID 自动重发。无响应的客户端取消也不回滚宿主。ConversationClient 仅接收受信宿主 transport；桌面代码注入已实现，但正式启动仍关闭，预览 UI 不调用真实宿主。

每条正文最多 16000 个 schema 字符、每会话 2000 条、全局 1000 会话、全部消息正文 UTF-8 总量 32 MiB。超额返回 409，不清理已保存消息；容量展示/清理工作流尚未实现。已删除 Case 的会话保持记录但不可读取，不创建替代归属；删除/保留策略需后续应用层设计。

验证包含真实 Fastify 管理通道与 SQLite、磁盘重启恢复、事务失败回滚、落库后丢回执、102 条分页和归属验证。尚未连接模型派发、授权 Run、实时事件、审批/证据或正式桌面重启；完整流程不能据此宣称通过。
