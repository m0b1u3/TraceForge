import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { z } from "zod";

export const LlmConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string(),
  jsonMode: z.enum(["json_schema", "json_object"]).optional(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export function loadLlmConfig(path = "config/llm.json", startDir = process.cwd()): LlmConfig | null {
  try {
    const resolved = resolveConfigPath(path, startDir);
    if (!resolved) return null;
    const raw = readFileSync(resolved, "utf8");
    const parsed = LlmConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function resolveConfigPath(path: string, startDir: string): string | null {
  if (isAbsolute(path)) return existsSync(path) ? path : null;
  let dir = startDir;
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, path);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}
