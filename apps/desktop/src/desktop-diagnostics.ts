import { appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type DiagnosticEvent = "started" | "ready" | "startup_failed" | "renderer_gone" | "shutdown" | "cleanup_failed" | "cache_cleared" | "cache_clear_failed" | "host";
/** Deliberately no free-text message, URL, prompt, header or error-stack fields. */
export function createDiagnostics(directory: string, maximumBytes = 10 * 1024 * 1024) {
  let available = true;
  const file = join(directory, "desktop.jsonl");
  function record(event: DiagnosticEvent, metadata: { level?: number; status?: number; durationMs?: number } = {}) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink()) throw new Error("Invalid log directory");
      for (let i = 0; i <= 5; i++) {
        const path = i ? `${file}.${i}` : file;
        try { if (!lstatSync(path).isFile()) throw new Error("Invalid log file"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (existsSync(file) && lstatSync(file).size >= maximumBytes) {
        if (existsSync(`${file}.5`)) unlinkSync(`${file}.5`);
        for (let i = 4; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        renameSync(file, `${file}.1`);
      }
      const safe = Object.fromEntries(Object.entries(metadata).filter(([key, value]) => ["level", "status", "durationMs"].includes(key) && typeof value === "number" && Number.isFinite(value)));
      const descriptor = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { appendFileSync(descriptor, JSON.stringify({ at: new Date().toISOString(), event, ...safe }) + "\n"); }
      finally { closeSync(descriptor); }
      available = true;
    } catch { available = false; /* Diagnostics must never stop an agent or hide its durable receipts. */ }
  }
  return { record, get available() { return available; }, stream: { write(line: string) {
    try { const value = JSON.parse(line); record("host", { level: value.level, status: value.res?.statusCode, durationMs: value.responseTime }); }
    catch { /* Never persist unstructured text that may contain credentials. */ }
  } } };
}
