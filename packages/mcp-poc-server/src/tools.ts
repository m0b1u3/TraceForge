import { mkdir, writeFile as fsWriteFile, readFile as fsReadFile, readdir } from "node:fs/promises";
import { resolveInWorkspace, truncateOutput } from "./workspace.js";

export interface ToolOutput { ok: boolean; text: string; meta?: Record<string, unknown> }

const MAX_OUT = 64 * 1024;

export async function writeFile(
  root: string,
  args: { caseId: string; path: string; content: string },
): Promise<ToolOutput> {
  try {
    const target = resolveInWorkspace(root, args.caseId, args.path);
    await mkdir(resolveInWorkspace(root, args.caseId), { recursive: true });
    await fsWriteFile(target, args.content, "utf8");
    return { ok: true, text: `wrote ${args.path}` };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}

export async function readFile(
  root: string,
  args: { caseId: string; path: string },
): Promise<ToolOutput> {
  try {
    const target = resolveInWorkspace(root, args.caseId, args.path);
    const content = await fsReadFile(target, "utf8");
    return { ok: true, text: truncateOutput(content, MAX_OUT) };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}

export async function listDir(
  root: string,
  args: { caseId: string; path?: string },
): Promise<ToolOutput> {
  try {
    const target = resolveInWorkspace(root, args.caseId, args.path ?? ".");
    await mkdir(resolveInWorkspace(root, args.caseId), { recursive: true });
    const entries = await readdir(target, { withFileTypes: true });
    const text = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
}
