import type { Fact } from "@traceforge/shared";

export interface Focus { host?: string; url?: string; note?: string; goal?: string }
export interface ConsumedSet { has(factId: string): boolean }

function hostOf(fact: Fact): string | undefined {
  const tag = fact.tags.find((t) => t.startsWith("host:"));
  return tag ? tag.slice(5) : undefined;
}

// 跨 scope（host 已知且不匹配）置 0；其余按类型/关键词/新鲜度/已消费综合打分。
export function relevanceScore(fact: Fact, focus: Focus, consumed?: ConsumedSet): number {
  const fHost = hostOf(fact);
  if (focus.host && fHost && fHost !== focus.host) return 0; // 跨 scope 直接 0

  let score = 1; // 基础分
  if (focus.host && fHost === focus.host) score += 3; // 同 host

  // 关键词命中：使用 bigram 匹配，支持中文连续字符串
  const focusText = `${focus.goal ?? ""} ${focus.note ?? ""}`.toLowerCase();
  const factText = `${fact.type} ${fact.title}`.toLowerCase();
  if (focusText.trim() && factText) {
    const grams = new Set<string>();
    const cleaned = focusText.replace(/[\s,，。/]+/g, "");
    for (let i = 0; i < cleaned.length - 1; i++) grams.add(cleaned.slice(i, i + 2));
    let hits = 0;
    for (const g of grams) if (factText.includes(g)) hits++;
    score += hits * 0.5;
  }

  // 时间新鲜度：越新越高（confirmed 关键事实不衰减——validity=valid 且 confidence≥1 视为关键）
  const ageMs = Date.now() - new Date(fact.createdAt).getTime();
  const ageDays = ageMs / 86_400_000;
  const isKey = fact.validity === "valid" && fact.confidence >= 1;
  if (!isKey) score += Math.max(0, 2 - ageDays * 0.1);

  // 已消费惩罚（已被采纳进成功 Action 的探索性 fact 降权）
  if (consumed?.has(fact.id)) score -= 2;

  return score;
}

export function topK(facts: Fact[], focus: Focus, k: number, consumed?: ConsumedSet): Fact[] {
  return facts
    .map((f) => ({ f, s: relevanceScore(f, focus, consumed) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.f);
}
