---
version: 1
slug: "apps-web-renderer-index-html"
primary_target: "renderer/index.html"
related_targets: ["renderer/main.tsx","renderer/host-workbench.tsx","renderer/host-workbench.css","renderer/conversation-replies.tsx"]
---

# 行动谱面工作台 surface brief

- Scope: apps/web 工作区内的 renderer，Operate。上述路径相对 apps/web，而非仓库根目录。单用户在本机工作台以对话推进调查，按需核对任务和证据。
- Confirmed: A 并列核查，随后用户明确自己的消息右对齐、智能体左对齐；不沿用旧前端，不重选视觉方向。
- Signature: 用户消息居右、助手正文居左，统一输入；工具活动与历史详情按需展开，任务和证据可返回对话。
- Runtime: main.tsx 在桌面对话桥接存在时挂载 HostWorkbench；模型设置模式单独挂载 ModelSettings；没有桌面桥接时的 Workbench 仅为独立演示，不是正式运行结果。
- Constraints: 宿主对话、模型流式回复和本机存档已有接线；历史读取属于同一工具循环，不另设手动复核模式。执行仍受授权与沙箱约束；已保存或已读取不等于已验证发现。具体完成度以 docs/development-status-and-roadmap.md（仓库根目录）为准。
- Approval: 用户确认的行动谱面方向与后续对话布局修正有效；不把旧演示截图或历史尺寸当作当前宿主实现。
