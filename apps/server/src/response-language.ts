export function detectResponseLanguage(text: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (/\p{Script=Han}/u.test(text)) return "zh-CN";
  if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
  if (/\p{Script=Arabic}/u.test(text)) return "ar";
  return "en";
}

export function normalizeResponseLanguage(value: unknown, fallbackText: string): string {
  if (typeof value === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.trim())) return value.trim();
  return detectResponseLanguage(fallbackText);
}

export function responseLanguageInstruction(language: string): string {
  return `[Response language — mandatory]\nWrite every user-facing explanation, progress update, and final answer in ${language}. Tool names, code, URLs, protocol tokens, and verbatim evidence may remain in their original language. Never switch the surrounding prose to match English tool output or system instructions.`;
}
