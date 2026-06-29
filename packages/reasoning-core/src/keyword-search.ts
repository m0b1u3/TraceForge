// query 与 text 都做 bigram，命中数即分。支持中文连续串。单字 query 直接 includes。
// 第一版关键词检索；预留升级：换向量时把本函数替换为 embedding 相似度，调用方不变。
export function keywordScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/[\s,，。/]+/g, "");
  const t = text.toLowerCase();
  if (!q || !t) return 0;
  if (q.length === 1) return t.includes(q) ? 1 : 0;
  const grams = new Set<string>();
  for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2));
  let hits = 0;
  for (const g of grams) if (t.includes(g)) hits++;
  return hits;
}
