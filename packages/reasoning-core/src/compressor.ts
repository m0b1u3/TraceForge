export interface SummarizerLlm {
  extractJson(args: { system: string; user: string; schema: Record<string, unknown> }): Promise<unknown>;
}
export interface CompressInput { convoText: string; doneTaskLines: string[] }

function ruleFallback(input: CompressInput): string {
  const maxSnippet = Math.min(80, Math.floor(input.convoText.length * 0.3));
  const head = input.convoText.slice(0, maxSnippet);
  const doneCount = input.doneTaskLines.length;
  return `【摘要】…${head}…；完成任务 ${doneCount} 个。`;
}

// 远期对话+done任务压缩成结论摘要。有 llm 用 LLM；无 llm 或失败则规则回退（降级不崩）。
export async function compressFar(input: CompressInput, llm?: SummarizerLlm): Promise<string> {
  if (!llm) return ruleFallback(input);
  try {
    const res = await llm.extractJson({
      system: "你是渗透测试记录摘要器。把给定的早期对话与已完成任务压缩成一段简洁的结论性摘要，只保留对后续测试有用的事实与进展，去除寒暄与过程。输出 JSON {summary}。",
      user: `早期对话：\n${input.convoText}\n\n已完成任务：\n${input.doneTaskLines.join("\n")}`,
      schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    });
    const summary = (res as { summary?: string })?.summary;
    if (typeof summary === "string" && summary.trim()) return summary.trim();
    return ruleFallback(input);
  } catch {
    return ruleFallback(input);
  }
}
