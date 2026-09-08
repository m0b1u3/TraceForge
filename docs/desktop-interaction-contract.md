# 对话优先桌面：交互与接线审查

状态：源码审查与产品设计草案，不是已实现的桌面 API。2026-09-05。

2026-09-06 实现增量：宿主会话与用户消息持久化接口已实现，详见 desktop-conversation-contract.md；本文其余未接线项仍成立。会话保存不等于 Planner 已收到补充消息，现有可见 renderer 仍为演示。

## 本次核实的结论

当前宿主有 Run、Work、审批、证据图、模型配置与可回放的 Agent 事件。它们足以支撑结构化调查展示，但不等于已有“用户发消息 → 助手回答 → 对话持久化 → 跨重启继续”的完整产品接口。新前端不能把这些对象拼成假聊天，也不能重启一套绕过现有底座的 Agent 循环。

## 已存在的合同

| 用户动作 | 当前入口 | 实际语义与限制 |
| --- | --- | --- |
| 查看/测试/保存模型 | routes.ts：GET/POST /api/config/llm、POST /test、GET /suppliers | LlmConfigService 返回 apiKeyMasked，主路由与备选路由隐藏 key。test 只做结构化 ping，不证明工具调用、流式或场景调查可用。配置当前是宿主级，不是对话级。 |
| 选择场景 | scenario-routes.ts：GET /api/scenarios/definitions | 返回运行 Definition；不等于已提供完整桌面目标表单。目标字段需要来自场景声明或独立场景视图，不能在通用桌面里固定 URL。 |
| 确认授权 | 同文件：POST /api/scenarios/authorizations | 需要 caseId、scenarioKind、scope、approvedBy、expiresAt，绑定有效 Package 并校验声明动作；自然语言同意不自动构造有效授权。 |
| 发起调查 | 同文件：POST /api/scenarios/runs | 需要 commandId、runId、caseId、goal、scopeRef、scenarioKind、definitionVersion；Case 必须存在且授权有效。命令支持幂等，重放返回 200，首次创建返回 201。 |
| 查看运行 | GET /api/scenarios/runs/:runId | 返回底座状态；不能把 Run status 与发送消息状态混为一谈。 |
| 暂停/恢复/取消 | POST 同 Run 下的 pause/resume/cancel | 带 commandId、expectedRevision、reason；恢复重新验证授权。未知响应先对账，不换新 ID 自动重发。暂停不应被描述为立刻撤销已发生的外部动作。 |
| 处理审批 | GET /api/scenarios/approvals、POST /:approvalId/resolve | resolve 带 commandId、expectedRevision、approved、reason，审批必须仍 pending；404/409 时重新核对，不显示乐观成功。批准不是扩大授权范围。 |
| 展开任务/协作 | GET /api/scenarios/runs/:runId/collaboration | 返回 runRevision、graphRevision、capturedAt 与有界展示；nodeLimit 最大 500，evaluationLimit 最大 100。不承诺跨所有数据源的原子快照，也不是完整聊天恢复点。 |
| 回放执行事件 | GET /api/scenarios/runs/:runId/agent-event-replay | 需要 caseId，使用不透明 cursor；返回 protocolVersion:2、nextCursor、hasMore、replayOnly:true。游标绑定 Case/Run/事件锚点；缺口/归属错配明确失败。 |
| 核查证据节点 | evidence-graph-routes.ts：GET /api/knowledge-graph/:caseId/nodes/:nodeId | 返回 center/nodes/edges，depth 为 0–5。不是任意本机文件或工件正文读取；无总量分页保证，需避免直接向 UI 输出巨大关系子图。 |
| 核查审计引用 | agent-event-stream 的 agent-audit-reference | 只支持声明的审计来源，绑定 caseId/runId/source/sourceId；不能当任意 artifact 下载接口。 |

实现来源：apps/server/src/routes.ts、llm-config-service.ts、scenario-routes.ts、scenario-collaboration-snapshot.ts、scenario-agent-event-stream.ts、evidence-graph-routes.ts；注册链位于 security-agent-foundation.ts。新 renderer 尚未对接这些入口。

## 四个必须补齐的产品适配点

### 1. 持久化对话及用户命令

在宿主应用层保存会话、用户消息、可展示的助手回复和关联 Run，不能把 UI 对话模型写入 Core。Case 是当前数据归属约束，不要求用户看见或理解 Case ID；适配层明确建立映射，不能凭空假设 Case 已被替换。

首次发送先形成待确认的调查意图，展示场景/范围/必要配置，再创建授权 Run。调查中的补充消息必须有明确送达、接受或拒绝回执；当前审查未找到专门的会话/消息路由，不能假设追加文字已经影响 Planner。

消息状态拟为“发送中、已保存、处理失败、结果待确认”；运行状态另外展示。应用层记录一次命令的稳定 ID 和结果归属，具体 schema 在实现前固定，不在本草案发明新 HTTP 路径。

### 2. 事件变成进度，不冒充聊天

packages/shared/src/scenario-agent-events.ts 中的协议是 turn 与 item 生命周期，包括 modelCall、toolCall、approval、controlChange。turn/progress 有 summary/refs，但没有用户消息或普通聊天文本增量合同。

新展示投影可以把它们汇成“正在执行／等待审批／结果待核对”的活动摘要；不能显示私有推理过程，也不能把 modelCall completed 写成“调查完成”或“漏洞已验证”。需要自然语言解释时由实际模型产生，持久化并绑定证据引用；演示文案必须标注为演示。

### 3. 引用解析与安全查看

点击引用时传稳定标识给宿主，不由 UI 拼接任意文件路径或执行富文本。展示节点 kind/status、来源和支持/反驳关系；找不到、超范围、已失效、过大时分别说明。工件正文、下载和场景专用查看器需要独立确认可用的安全读取合同，不假设 graph ref 就是 URL。

证据详情打开后保留当前草稿和阅读位置；Esc 关闭并回到触发引用。对话的结论与证据状态独立，未验证、被反驳和未知结果不得套用成功样式。

### 4. 恢复与模型配置作用域

对话保存和 Run/Agent 回放是两个状态源。重连先确认会话与 Run 归属，再按游标读完整缺页，按事件 ID/sequence 去重；不把 collaboration 快照和事件流假称为同一个原子时点。新任务切换后丢弃上一任务迟到的展示响应，但不丢弃其持久化结果。

现有模型配置是宿主级。第一版设置必须说明生效范围，不提供没有后端保证的“仅本对话切换模型”按钮。若需要会话级模型选择，先在现有模型路由端口补齐明确的绑定，不能从 renderer 直连厂商。

## 新工作台行为草案

交互主线已由用户确认，具体视觉方案待选择。

1. 打开软件：进入上次会话或空对话；缺模型/缺场景时显示可操作的配置提示，不伪装已就绪。
2. 输入意图：保留输入草稿，明确准备调查与真正执行的分界；回车是否发送遵循输入法组合状态，不能截断中文输入。
3. 运行中：对话正文占主位，活动收敛成简短进度与引用，待审批固定可发现，用户可暂停或取消。
4. 核查：点任务/证据引用展开附属区域；默认不显示永久三栏、关系大图、资源目录或 Worker 列表。
5. 结束/中断：结论、限制与未解决项分别可见；关闭重开恢复到真实状态，不以完成动画代替回执。

长对话用增量加载；窗口变窄时详情覆盖式打开并管理焦点，不挤压正文到不可读。设置入口独立；Skills/知识/MCP 的管理只在主动进入时展开。系统字体、对比度、键盘、文本选择/复制和减少动态效果是实现验收项，具体颜色和布局不沿用旧代码。

## 一次完整验收，而非逐按钮交付

- 无配置开始 → 安全配置模型 → 准备调查 → 确认范围 → 发起 Run → 收到真实状态 → 审批 → 打开证据 → 暂停/恢复 → 重启后回到同一调查。
- 同批检查：中文输入、重复发送、断线回执未知、审批失效、游标缺口、任务切换迟到响应、证据缺失/巨大内容、密钥不出现在历史和日志。
- 先用有明确标签的受控数据验证交互；真实模型授权未提供时不记为真实调查通过。
- 验收前桌面退役围栏保持。图像是设计草图，不是可点击 renderer，更不是后端接通证明。
