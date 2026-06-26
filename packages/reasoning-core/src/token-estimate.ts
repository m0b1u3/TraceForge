// 字符估算 token，无需 tokenizer 库。CJK 字符信息密度高，按更高权重计。
// 偏差走保守方向（宁可高估→少塞内容→不爆窗口）。
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // CJK 统一表意文字范围 (U+4E00-U+9FFF) + 全角范围 (U+FF00-U+FFEF)
    if (/[一-鿿＀-￯]/.test(ch)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}
