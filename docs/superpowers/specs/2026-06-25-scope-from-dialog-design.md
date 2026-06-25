# TraceForge 对话驱动授权范围 设计文档

> 状态：设计已确认，待实现。聚焦小改动，动 scope 安全边界故留设计记录。

## 1. 目标

把"授权范围（allowHosts）"的设定从"新建 Case 时硬填"改为"对话驱动 + 人批准"：
- 新建 Case 只填名称，allowHosts 可空。
- 人在对话里给目标 → agent 越界时调现有 `propose_scope_expansion` 工具提议把目标 host 纳入范围 → 前端弹「批准纳入」卡片 → 人点批准才把 host 真加进该 Case 的 allowHosts。
- **批准只改 allowHosts，不自动重跑 agent**；人接着在对话重发目标，agent 这次即可过 Scope Guard。

**安全不变量**：人始终把守最后一道门——LLM 只能"提议"扩范围，不能自己改 scope。Scope Guard 仍是 deny-by-default。

## 2. 数据流

```
新建 Case（名称, allowHosts 可空）
  → 人对话给目标
  → agent http_replay 越界 → Scope Guard 拒
  → agent 调 propose_scope_expansion(host, reason)
  → 后端 emit scope_expansion_proposed { caseId, host, reason }
  → 前端弹「批准纳入 <host>」卡片（在 Agent 对话区）
  → 人点批准 → POST /api/cases/:id/scope/approve { host }
  → 后端 CaseStore.addAllowHost(caseId, host) 更新 scopeRules
  → emit scope_updated { caseId, allowHosts } → 前端清掉卡片 + 可提示
  → 人重发目标 → agent 这次过 Scope Guard
```

## 3. 后端改动

- **CaseStore.addAllowHost(caseId, host): Case | undefined** —— 读 case，把 host 加进 scopeRules[0].allowHosts（去重），写回，返回更新后的 Case。
- **POST /api/cases/:id/scope/approve** body `{ host }` → addAllowHost → emit `scope_updated` → 返回更新后的 case（404 当 case 不存在）。
- **新事件 scope_updated** `{ type: "scope_updated"; caseId: string; allowHosts: string[] }`。
- 新建 case 路由已支持空 allowHosts（allowHosts 数组可空，ScopeRuleSchema.allowHosts 是数组、空数组合法 = deny-all）。

## 4. 前端改动

- **store**：加 `pendingScope: { host: string; reason: string } | null`；WS 处理 `scope_expansion_proposed` → setPendingScope；`scope_updated` → 清 pendingScope（host 已纳入）。
- **api**：`approveScope(caseId, host)` → POST /scope/approve。
- **AgentPanel**：pendingScope 存在时在对话区弹一张卡片（类似审批卡）：「agent 建议把 `<host>` 纳入授权范围（reason）」+ 「批准纳入」按钮 → 调 approveScope。
- 新建 Case 表单 host 已改为可选（已完成）。

## 5. 错误处理

- approve 时 case 不存在 → 404。
- host 已在 allowHosts → 幂等（去重，仍返回成功）。
- pendingScope 同时只保留最近一条（多次提议覆盖）。

## 6. 核心理念落点

- **安全边界不失控**：LLM 只提议，人批准才扩范围；Scope Guard 仍 deny-by-default。
- **零硬编码不受影响**：范围是人/LLM 协同的运行时数据，不写死。
- **人机协同**：把"设范围"也纳入"agent 提议 + 人确认"的统一模式（与审批门、Fact 确认一致）。

## 7. 测试

- CaseStore.addAllowHost 单测：加 host 去重、case 不存在返回 undefined。
- 路由单测（inject）：POST /scope/approve 加 host 后 case 的 allowHosts 含该 host；不存在 case 返回 404。
- 前端：build + tsc + 端到端手测（agent 提议 → 弹卡 → 批准 → 重发目标过 scope）。
