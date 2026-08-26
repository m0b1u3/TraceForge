import { createHash } from "node:crypto";
import type { OutputDistiller, ToolExecutionResult } from "./model.js";

export class BoundedOutputDistiller implements OutputDistiller {
  async distill(result: ToolExecutionResult, maximumCharacters: number): Promise<{ summary: string; refs: string[] }> {
    const rawHash = createHash("sha256").update(result.raw).digest("hex");
    const prefix = `[${result.status}; raw-sha256=${rawHash}; raw-characters=${result.raw.length}] ${result.summary}`;
    if (prefix.length >= maximumCharacters) return { summary: prefix.slice(0, maximumCharacters), refs: result.refs };
    const remaining = maximumCharacters - prefix.length - 1;
    const raw = result.raw.length <= remaining
      ? result.raw
      : `${result.raw.slice(0, Math.max(0, remaining - 64))}\n[${result.raw.length - remaining} characters omitted]`;
    return { summary: `${prefix}\n${raw}`, refs: [...new Set(result.refs)] };
  }
}
