import type { Task, SessionState, Hypothesis } from "@traceforge/shared";
import { estimateTokens } from "./token-estimate.js";

export interface ConvoEntry { role: "user" | "assistant"; text: string }
export interface SharedKnowledgeContext {
  verifiedFindings: string[];
  identities: string[];
  attackPaths: string[];
  solverInsights?: string[];
  excludedConflictCount: number;
  injectedFactIds: string[];
  injectedKnowledgeRefs?: Array<{
    id: string;
    kind: "fact" | "identity" | "attack_path";
  }>;
}
export interface ContextInput {
  goal: string;
  state?: SessionState;
  recentConvo: ConvoEntry[];
  factCount: number;
  trafficCount: number;
  summaryCount: number;
  activeHypotheses: Hypothesis[];
  activeTasks: Task[];
  taskPriorities?: Record<string, { score: number; reasons: string[] }>;
  doneTaskSummaries: string[];
  farSummary?: string;
  scopeHosts: string[];
  sharedKnowledge?: SharedKnowledgeContext;
}
export interface ContextBudget { maxTokens: number; focusReserve: number }
export interface BuiltMessage { role: "user" | "assistant"; content: string }
export interface BuildResult { messages: BuiltMessage[]; injectedFactIds: string[]; estimatedTokens: number; degraded: string[] }

export function buildContext(input: ContextInput, budget: ContextBudget): BuildResult {
  const degraded: string[] = [];

  // ---- Layer 1 焦点（永不裁剪，仅长文本可截断）----
  const stateLine = input.state
    ? `当前目标：${input.state.currentGoal || input.goal}；阶段：${input.state.phase}；焦点：${JSON.stringify(input.state.focus)}`
    : `当前目标：${input.goal}`;
  const scopeLine = `已授权范围 host：${input.scopeHosts.length ? input.scopeHosts.join(", ") : "（空，需先 propose_scope_expansion 提议并经人批准）"}`;
  const taskLine = input.activeTasks.length
    ? `活跃任务（已按执行优先级排序）：\n${input.activeTasks.map((t) => {
      const priority = input.taskPriorities?.[t.id];
      const ranking = priority ? ` [score:${priority.score}; ${priority.reasons.join(", ")}]` : "";
      const gate = t.relationshipGate
        ? ` [RELATIONSHIP GATE: blocked by ${t.relationshipGate.blockedHypothesisIds.join(", ")}; do not execute or create a duplicate task; wait for those hypothesis gates to clear]`
        : "";
      return `- ${t.id} [${t.status}/${t.priority}]${ranking}${gate} ${t.title}`;
    }).join("\n")}`
    : "活跃任务：（无）";
  const inventoryLine = `📁 本 Case 已积累：${input.factCount} 个 Fact、${input.trafficCount} 条流量、${input.summaryCount} 条远期对话摘要。需要历史发现时用 search_facts("关键词") / search_traffic(...) / recall_conversation(...) 检索；要某 Fact 细节用 get_fact_detail(id)。`;
  const sharedKnowledgeLine = input.sharedKnowledge
    ? [
        "跨 Run 已验证项目知识（只复用 valid/active/non-invalidated 项；不要把排除的冲突知识当结论）：",
        input.sharedKnowledge.verifiedFindings.length ? `已验证 Findings：\n${input.sharedKnowledge.verifiedFindings.map((item) => `- ${item}`).join("\n")}` : "已验证 Findings：（无）",
        input.sharedKnowledge.identities.length ? `可用 Identities：\n${input.sharedKnowledge.identities.map((item) => `- ${item}`).join("\n")}` : "可用 Identities：（无）",
        input.sharedKnowledge.attackPaths.length ? `攻击路径：\n${input.sharedKnowledge.attackPaths.map((item) => `- ${item}`).join("\n")}` : "攻击路径：（无）",
        input.sharedKnowledge.solverInsights?.length ? `Solver 研究摘要（仅作线索，不是 Fact 或验证结论）：\n${input.sharedKnowledge.solverInsights.map((item) => `- ${item}`).join("\n")}` : "",
        input.sharedKnowledge.excludedConflictCount > 0 ? `已隔离 ${input.sharedKnowledge.excludedConflictCount} 条 conflicted/superseded/stale 知识；仅在主动检索并复核时使用。` : "",
      ].filter(Boolean).join("\n")
    : "";

  // ---- Layer 2 活跃假设----
  const buildLayer2 = (): string => {
    if (!input.activeHypotheses.length) return "";
    return `活跃假设：\n${input.activeHypotheses.map((h) => `- ${h.id} [${h.status}] ${h.statement}`).join("\n")}`;
  };

  // ---- Layer 3 摘要（最先被砍）----
  const buildLayer3 = (): string => {
    const parts: string[] = [];
    if (input.farSummary) parts.push(`早期工作摘要：${input.farSummary}`);
    if (input.doneTaskSummaries.length) parts.push(`已完成任务结论：\n${input.doneTaskSummaries.map((s) => `- ${s}`).join("\n")}`);
    return parts.join("\n");
  };
  let layer3 = buildLayer3();
  const layer2 = buildLayer2();

  const assemble = (): string => {
    const sections = [stateLine, scopeLine, taskLine, inventoryLine];
    if (sharedKnowledgeLine) sections.push(sharedKnowledgeLine);
    if (layer2) sections.push(layer2);
    if (layer3) sections.push(layer3);
    return sections.join("\n\n");
  };
  let ctx = assemble();

  const total = () => estimateTokens(ctx) + input.recentConvo.reduce((a, c) => a + estimateTokens(c.text), 0) + estimateTokens(input.goal);

  // 降级 1：砍 Layer3
  if (total() > budget.maxTokens && layer3) { layer3 = ""; degraded.push("dropped-layer3"); ctx = assemble(); }
  // 降级 2：截断焦点长文本
  if (total() > budget.maxTokens) {
    const reserveChars = budget.focusReserve * 4;
    if (ctx.length > reserveChars) { ctx = ctx.slice(0, reserveChars) + "\n…（上下文已截断）"; degraded.push("truncated-context"); }
  }

  const messages: BuiltMessage[] = [{ role: "user", content: `【会话上下文】\n${ctx}` }];
  for (const c of input.recentConvo) messages.push({ role: c.role, content: c.text });
  messages.push({ role: "user", content: input.goal });

  return { messages, injectedFactIds: input.sharedKnowledge?.injectedFactIds ?? [], estimatedTokens: total(), degraded };
}
