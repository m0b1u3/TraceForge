import { writeSync } from "node:fs";
import { authority, controls, database } from "../src/test-fixtures/execution-recovery.ts";

const [path, mode, phase, commandJson, publicKeyPem] = process.argv.slice(2);
const sqlite = database(path);
const c = controls(sqlite, {
  authority: { ...authority(), publicKeyPem },
  stage(current) {
    if (mode === "crash" && current === phase) {
      writeSync(1, JSON.stringify({ checkpoint: phase }) + "\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
});
if (mode === "crash") await c.recovery.recover(JSON.parse(commandJson));
else {
  const result = await c.recovery.resume("recover", "operator");
  writeSync(1, JSON.stringify({ outcome: result.outcome, workCount: c.runtime.load("run").workItems.length,
    audits: c.reconciliation.listAudits("call").length, retryAudits: sqlite.prepare("SELECT count(*) AS n FROM scenario_work_retry_audits").get().n,
    integrity: sqlite.pragma("integrity_check", { simple: true }) }) + "\n");
  sqlite.close();
}
