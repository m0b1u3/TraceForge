import type { JournalStorage } from "./host-conversation-controller";
const key = "traceforge.desktop.last-conversation.v1";
/** View location only. Restoring it authorizes reads, never inference or execution. */
export function readConversationLocation(storage: JournalStorage): string | null {
  const value = storage.getItem(key);
  if (value === null || value === "new") return null;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid saved conversation location");
  return value;
}
export function saveConversationLocation(storage: JournalStorage, id: string | null) {
  if (id !== null && !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid conversation location");
  storage.setItem(key, id ?? "new");
}
