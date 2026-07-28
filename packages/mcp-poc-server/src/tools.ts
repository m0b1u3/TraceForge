import { spawn } from "node:child_process";
import { mkdir, writeFile as fsWriteFile, readFile as fsReadFile, readdir } from "node:fs/promises";
import { resolveInWorkspace, truncateOutput } from "./workspace.js";

export interface ToolOutput { ok: boolean; text: string }

const MAX_OUT = 64 * 1024;

export async function execCommand(
  root: string,
  args: { caseId: string; command: string; timeoutMs?: number },
): Promise<ToolOutput> {
  if (process.platform === "win32" && /(?:^|\s)(?:grep|sed|awk|chmod|which)(?:\s|$)|(?:^|\s)\/dev\/null(?:\s|$)|\|\||&&/.test(args.command)) {
    return {
      ok: false,
      text: "command rejected before execution: this workspace uses cmd.exe on Windows; use cmd.exe-compatible commands and operators",
    };
  }
  let cwd: string;
  try {
    cwd = resolveInWorkspace(root, args.caseId);
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
  await mkdir(cwd, { recursive: true });
  const timeout = Math.min(args.timeoutMs ?? 60000, 300000);
  return new Promise<ToolOutput>((resolveP) => {
    const child = spawn(args.command, { cwd, shell: true });
    let out = "", err = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const head = killed ? `exit=timeout(${timeout}ms)` : `exit=${code}`;
      resolveP({
        ok: !killed && code === 0,
        text: `${head}\n--- stdout ---\n${truncateOutput(out, MAX_OUT)}\n--- stderr ---\n${truncateOutput(err, MAX_OUT)}`,
      });
    });
    child.on("error", (e) => { clearTimeout(timer); resolveP({ ok: false, text: `spawn failed: ${e.message}` }); });
  });
}

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
