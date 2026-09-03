import { appendFileSync, readFileSync, writeSync } from "node:fs";
import {
  EXECUTION_PROTOCOL_VERSION,
  ExecutionNodeRpcServer,
  ExecutionRpcDispatcher,
  LocalExecutionNode,
  permissionProfileFingerprint,
  resourceLimitsFingerprint,
} from "@traceforge/execution-node";
import { createDb, getSqliteClient } from "../src/db/client.js";
import { SqliteProcessOperationJournal } from "../src/execution-process-operation-journal.js";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sqlite = getSqliteClient(createDb(config.databasePath));
const durableJournal = new SqliteProcessOperationJournal(sqlite);
const effect = (operation, detail = {}) => appendFileSync(config.effectLogPath, `${JSON.stringify({ operation, ...detail })}\n`);
const checkpoint = (phase) => {
  writeSync(1, `${JSON.stringify({ checkpoint: phase })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

class FaultJournal {
  claim(observation) {
    durableJournal.claim(observation);
    if (config.fault === "after-claim" && observation.identity.operation === config.operation) checkpoint("after-claim");
  }
  complete(observation) { durableJournal.complete(observation); }
  get(operationId) { return durableJournal.get(operationId); }
}

class EffectProcess {
  pid = process.pid;
  outputListeners = [];
  exitListeners = [];
  errorListeners = [];
  resourceListeners = [];
  onOutput(listener) { this.outputListeners.push(listener); }
  onExit(listener) { this.exitListeners.push(listener); }
  onError(listener) { this.errorListeners.push(listener); }
  onResourceLimit(listener) { this.resourceListeners.push(listener); }
  async writeInput(data) { effect("process.writeInput", { bytes: data.length }); }
  async closeInput() {}
  async resizeTerminal(columns, rows) { effect("process.resizeTerminal", { columns, rows }); }
  async sendSignal(signal) { effect("process.signal", { signal }); }
  async terminate(force) { effect("process.terminate", { force }); }
}

const launcher = {
  async launch(request) {
    return {
      process: new EffectProcess(),
      enforcement: {
        sandboxBackend: "test-local-process",
        sandboxed: true,
        filesystemPolicyApplied: true,
        permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
        resourceLimitsApplied: true,
        resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources),
        network: "deny",
      },
    };
  },
};

const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const node = new LocalExecutionNode(launcher, {
  id: config.nodeId,
  platform,
  sandboxBackends: ["test-local-process"],
  operationJournal: new FaultJournal(),
  capabilities: {
    process: { spawn: true, stdio: true, tty: true, adoption: true, resourceLimits: true,
      signals: ["interrupt", "terminate", "kill"] },
  },
});
const baseDispatcher = new ExecutionRpcDispatcher(node);
const dispatcher = {
  async dispatch(method, params) {
    const prior = typeof params?.operationId === "string" ? durableJournal.get(params.operationId) : undefined;
    const result = await baseDispatcher.dispatch(method, params);
    if (method === "process.adopt" && !prior) effect("process.adopt", { workerId: params.attribution.workerId });
    if (config.fault === "after-complete" && method === config.operation) checkpoint("after-complete");
    return result;
  },
};
const server = new ExecutionNodeRpcServer(dispatcher, { authToken: config.authToken });
await server.listen({ kind: "pipe", path: config.pipePath });
writeSync(1, `${JSON.stringify({ ready: true, protocol: EXECUTION_PROTOCOL_VERSION })}\n`);

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  void server.close().catch(() => undefined).finally(() => {
    if (sqlite.open) sqlite.close();
    process.exit(0);
  });
});
