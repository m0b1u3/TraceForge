import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DesktopJournalStore } from "./desktop-journal-store.js";
it("atomically restores bounded desktop state independently of the renderer origin", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-journal-")), file = join(root, "journal.json");
  try {
    const key = "traceforge.desktop.last-conversation.v1", first = new DesktopJournalStore(file);
    first.request({ operation: "set", key, value: "conversation_1" });
    const restarted = new DesktopJournalStore(file);
    restarted.request({operation:"set",key:"traceforge.reply-queue.conversation_1",value:'{"commandId":"pending"}'});
    expect(new DesktopJournalStore(file).request({operation:"get",key:"traceforge.reply-queue.conversation_1"})).toBe('{"commandId":"pending"}');
    expect(restarted.request({ operation: "get", key })).toBe("conversation_1");
    restarted.request({ operation: "remove", key }); expect(new DesktopJournalStore(file).request({ operation: "get", key })).toBeNull();
    for (const input of [{ operation: "set", key: "apiKey", value: "secret" }, { operation: "get", key: "../../file" }, { operation: "set", key, value: "x".repeat(262145) }, { operation: "get", key, value: "unexpected" }]) expect(() => restarted.request(input)).toThrow();
    expect(readFileSync(file, "utf8")).not.toContain("secret");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
