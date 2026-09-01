import { createDb, getSqliteClient } from "../src/db/client.ts";
import { reserveToolReceipt } from "../src/db/execution-storage.ts";
import { SqliteToolReceiptStore } from "../src/worker-execution-adapters.ts";

const [path, phase] = process.argv.slice(2);
const sqlite = getSqliteClient(createDb(path));
if (phase === "inspect") {
  const usage = sqlite.prepare("SELECT records, bytes FROM execution_storage_usage WHERE kind = 'receipt'").get();
  const entry = sqlite.prepare("SELECT state, bytes FROM execution_storage_entries WHERE kind = 'receipt' AND entry_key = 'call'").get();
  const receipt = await new SqliteToolReceiptStore(sqlite).get("call");
  process.stdout.write(JSON.stringify({ usage, entry, receipt: Boolean(receipt), integrity: sqlite.pragma("integrity_check", { simple: true }) }) + "\n");
  sqlite.close();
} else {
  sqlite.transaction(() => reserveToolReceipt(sqlite, "call"))();
  if (phase !== "reservation") {
    if (phase === "receipt-uncommitted") sqlite.exec("BEGIN IMMEDIATE");
    await new SqliteToolReceiptStore(sqlite).put("call", { status: "succeeded", summary: "confirmed", raw: "result", refs: [], retryable: false });
  }
  process.stdout.write(JSON.stringify({ phase }) + "\n");
  // Parent kills this independent process at the selected persisted/uncommitted boundary.
  setInterval(() => {}, 1000);
}
