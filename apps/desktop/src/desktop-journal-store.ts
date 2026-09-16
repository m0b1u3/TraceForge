import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const validKey = (key: string) => ["traceforge.desktop.session-drafts.v1", "traceforge.desktop.last-conversation.v1", "traceforge.desktop.conversation-command.v1"].includes(key)
  || /^traceforge\.reply-queue\.[a-zA-Z0-9_-]{1,100}$/.test(key)
  || /^traceforge\.execution\.[a-zA-Z0-9_-]{1,100}$/.test(key)
  || /^traceforge:permission-change:[a-zA-Z0-9_-]{1,100}:[a-zA-Z0-9_-]{1,100}$/.test(key);
const entryLimit=(key:string)=>key==="traceforge.desktop.conversation-command.v1"?3200000:262144;

/** Fixed host file, atomic writes, no model credential keys or caller-controlled paths. */
export class DesktopJournalStore {
  private values: Record<string, string> = Object.create(null);
  constructor(private file: string) {
    if (!existsSync(file)) return;
    if (statSync(file).size > 8 * 1048576) throw new Error("Desktop journal capacity exceeded");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 2048) throw new Error("Invalid desktop journal");
    for (const [key, value] of Object.entries(parsed)) {
      if (!validKey(key) || typeof value !== "string" || value.length > entryLimit(key)) throw new Error("Invalid desktop journal entry");
      this.values[key] = value;
    }
  }
  request(input: unknown): string | null {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid journal request");
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !["operation", "key", "value"].includes(key)) || typeof value.key !== "string" || !validKey(value.key)) throw new Error("Invalid journal key");
    if (value.operation === "get" && value.value === undefined) return this.values[value.key] ?? null;
    if (value.operation !== "remove" && value.operation !== "set" || value.operation === "set" && (typeof value.value !== "string" || value.value.length > entryLimit(value.key))
      || value.operation === "remove" && value.value !== undefined) throw new Error("Invalid journal operation");
    const next = { ...this.values };
    if (value.operation === "set") next[value.key] = value.value as string; else delete next[value.key];
    const text = JSON.stringify(next);
    if (Object.keys(next).length > 2048 || Buffer.byteLength(text) > 8 * 1048576) throw new Error("Desktop journal capacity exceeded");
    writeFileSync(`${this.file}.pending`, text, { mode: 0o600 }); renameSync(`${this.file}.pending`, this.file); this.values = next;
    return null;
  }
}
