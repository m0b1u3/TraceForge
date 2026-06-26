import type { Fact, Task, SessionState, Hypothesis } from "@traceforge/shared";
import { estimateTokens } from "./token-estimate.js";
import { topK, type Focus } from "./relevance.js";

export interface ConvoEntry { role: "user" | "assistant"; text: string }
export interface ContextInput {
  goal: string;
  state?: SessionState;
  recentConvo: ConvoEntry[];
  facts: Fact[];
  activeHypotheses: Hypothesis[];
  activeTasks: Task[];
  doneTaskSummaries: string[];
  farSummary?: string;
  scopeHosts: string[];
  protectedFactIds: Set<string>;
}
export interface ContextBudget { maxTokens: number; focusReserve: number }
export interface BuiltMessage { role: "user" | "assistant"; content: string }
export interface BuildResult { messages: BuiltMessage[]; injectedFactIds: string[]; estimatedTokens: number; degraded: string[] }

function focusFrom(input: ContextInput): Focus {
  return { host: input.state?.focus.host, url: input.state?.focus.url, note: input.state?.focus.note, goal: input.goal };
}

export function buildContext(input: ContextInput, budget: ContextBudget): BuildResult {
  const degraded: string[] = [];
  const focus = focusFrom(input);

  // ---- Layer 1 焦点（永不裁剪，仅长文本可截断）----
  const stateLine = input.state
    ? `当前目标：${input.state.currentGoal || input.goal}；阶段：${input.state.phase}；焦点：${JSON.stringify(input.state.focus)}`
    : `当前目标：${input.goal}`;
  const scopeLine = `已授权范围 host：${input.scopeHosts.length ? input.scopeHosts.join(", ") : "（空，需先 propose_scope_expansion 提议并经人批准）"}`;
  const taskLine = input.activeTasks.length
    ? `活跃任务：\n${input.activeTasks.map((t) => `- [${t.status}] ${t.title}`).join("\n")}`
    : "活跃任务：（无）";

  // ---- Layer 2 相关（受预算调 K）----
  let k = 12;
  const buildLayer2 = (kk: number): { text: string; ids: string[] } => {
    const picked = topK(input.facts, focus, kk);
    const ids = new Set(picked.map((f) => f.id));
    for (const f of input.facts) if (input.protectedFactIds.has(f.id)) ids.add(f.id);
    const chosen = input.facts.filter((f) => ids.has(f.id));
    const factText = chosen.length ? chosen.map((f) => `- ${f.id} [${f.type}] ${f.title}`).join("\n") : "（无相关 Fact）";
    const hypoText = input.activeHypotheses.length ? input.activeHypotheses.map((h) => `- ${h.id} [${h.status}] ${h.statement}`).join("\n") : "";
    const text = `相关 Fact：\n${factText}` + (hypoText ? `\n活跃假设：\n${hypoText}` : "");
    return { text, ids: chosen.map((f) => f.id) };
  };

  // ---- Layer 3 摘要（最先被砍）----
  const buildLayer3 = (): string => {
    const parts: string[] = [];
    if (input.farSummary) parts.push(`早期工作摘要：${input.farSummary}`);
    if (input.doneTaskSummaries.length) parts.push(`已完成任务结论：\n${input.doneTaskSummaries.map((s) => `- ${s}`).join("\n")}`);
    return parts.join("\n");
  };
  let layer3 = buildLayer3();

  let l2 = buildLayer2(k);
  const assemble = (): string => {
    const sections = [stateLine, scopeLine, taskLine, l2.text];
    if (layer3) sections.push(layer3);
    return sections.join("\n\n");
  };
  let ctx = assemble();

  const total = () => estimateTokens(ctx) + input.recentConvo.reduce((a, c) => a + estimateTokens(c.text), 0) + estimateTokens(input.goal);

  // 降级 1：砍 Layer3
  if (total() > budget.maxTokens && layer3) { layer3 = ""; degraded.push("dropped-layer3"); ctx = assemble(); }
  // 降级 2：降 K
  while (total() > budget.maxTokens && k > 3) { k -= 3; l2 = buildLayer2(k); degraded.push(`reduced-k-${k}`); ctx = assemble(); }
  // 降级 3：截断焦点长文本
  if (total() > budget.maxTokens) {
    const reserveChars = budget.focusReserve * 4;
    if (ctx.length > reserveChars) { ctx = ctx.slice(0, reserveChars) + "\n…（上下文已截断）"; degraded.push("truncated-context"); }
  }

  const messages: BuiltMessage[] = [{ role: "user", content: `【会话上下文】\n${ctx}` }];
  for (const c of input.recentConvo) messages.push({ role: c.role, content: c.text });
  messages.push({ role: "user", content: input.goal });

  return { messages, injectedFactIds: l2.ids, estimatedTokens: total(), degraded };
}
