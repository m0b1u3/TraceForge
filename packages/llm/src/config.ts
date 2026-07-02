import { readFileSync } from "node:fs";
import { z } from "zod";

export const LlmConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string(),
  jsonMode: z.enum(["json_schema", "json_object"]).optional(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export function loadLlmConfig(path = "config/llm.json"): LlmConfig | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = LlmConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
