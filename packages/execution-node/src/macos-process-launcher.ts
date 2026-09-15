import type { Writable } from "node:stream";
import { constants } from "node:os";
import type { ManagedProcess, ProcessLauncher, LaunchedProcess } from "./runtime.js";
import { permissionProfileFingerprint, resourceLimitsFingerprint, type StartProcessRequest, type ProcessSignal, type ResourceLimitKind } from "./protocol.js";
import { runMacosOwnedExecution } from "./macos-owned-execution.js";
import { writeProcessPipe } from "./process-watchdog.js";
import type { MacosSystemServicePolicy } from "./macos-seatbelt.js";
import type { MacosExecutionBindingResolver } from "./macos-execution-binding.js";

/** Local owned-group transport; only a confirmed empty-group terminal emits exit. */
export class MacosProcessLauncher implements ProcessLauncher {
  private readonly services: MacosSystemServicePolicy | undefined;
  /** Host-owned dedicated launcher policy, never a task/RPC argument. */
  constructor(private readonly helper: { path: string; sha256: string }, services?: MacosSystemServicePolicy,
    private readonly resolveBinding?: MacosExecutionBindingResolver) {
    this.services = services ? structuredClone(services) : undefined;
  }
  async launch(request: StartProcessRequest): Promise<LaunchedProcess> {
    const binding = await this.resolveBinding?.(structuredClone(request));
    const abort = new AbortController();
    let input: Writable | null = null;
    let control: Writable | undefined;
    let resolveReady!: (pid: number) => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const outputs: Array<["stdout" | "stderr", Buffer]> = [];
    let bufferedBytes = 0;
    let outputListener: Parameters<ManagedProcess["onOutput"]>[0] | undefined;
    const exitListeners: Array<Parameters<ManagedProcess["onExit"]>[0]> = [];
    let errorListener: Parameters<ManagedProcess["onError"]>[0] | undefined;
    let resourceListener: Parameters<ManagedProcess["onResourceLimit"]>[0] | undefined;
    let exit: [number | null, string | null] | undefined, failure: Error | undefined, limit: ResourceLimitKind | undefined;
    const fail = (error: Error) => { failure = error; rejectReady(error); errorListener?.(error); };
    const completion = runMacosOwnedExecution(request, this.helper, abort.signal, {
      ready(pid, stream, commands) { input = stream; control = commands; resolveReady(pid); },
      output(stream, bytes) {
        if (outputListener) outputListener(stream, bytes);
        else if (bufferedBytes < request.outputLimitBytes) {
          const retained = Buffer.from(bytes.subarray(0, request.outputLimitBytes - bufferedBytes));
          outputs.push([stream, retained]); bufferedBytes += retained.length;
        }
      },
      resourceLimit(resource) { limit = resource; resourceListener?.(resource); },
    }, this.services, binding).then(async result => {
      await binding?.release();
      if (!result.cleanupConfirmed) { fail(new Error("macOS process-group cleanup is unconfirmed")); return; }
      if (result.reason === "supervision_failed") { fail(new Error("macOS process supervision failed")); return; }
      const name = Object.entries(constants.signals).find(([, value]) => value === result.signal)?.[0] ?? null;
      exit = [result.exitCode, name]; for (const listener of exitListeners) listener(...exit);
      rejectReady(new Error("macOS supervisor exited before readiness"));
    }, async error => { await binding?.release(); fail(error instanceof Error ? error : new Error(String(error))); })
      .catch(error => fail(error instanceof Error ? error : new Error("macOS execution binding cleanup failed")));
    const pid = await ready;
    const stop = async () => { abort.abort(); await completion; if (failure) throw failure; };
    const managed: ManagedProcess = {
      pid,
      onOutput(listener) { outputListener = listener; for (const entry of outputs.splice(0)) listener(...entry); },
      onExit(listener) { exitListeners.push(listener); if (exit) listener(...exit); },
      onError(listener) { errorListener = listener; if (failure) listener(failure); },
      onResourceLimit(listener) { resourceListener = listener; if (limit) listener(limit); },
      async writeInput(bytes) { if (!input || exit || failure) throw new Error("macOS input is closed"); await writeProcessPipe(input, bytes, AbortSignal.timeout(2000)); },
      async closeInput() { if (input && !input.writableEnded) await writeProcessPipe(input, null, AbortSignal.timeout(2000)); },
      async resizeTerminal(columns, rows) {
        if (!request.terminal || !control || exit || failure || ![columns, rows].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 500)) throw new Error("Invalid terminal resize");
        await writeProcessPipe(control, Buffer.from(`R ${columns} ${rows}\n`), AbortSignal.timeout(2000));
      },
      async sendSignal(signal: ProcessSignal) {
        if (signal === "interrupt") {
          if (!control || exit || failure) throw new Error("macOS process is closed");
          await writeProcessPipe(control, Buffer.from("I\n"), AbortSignal.timeout(2000));
        } else if (signal === "terminate" || signal === "kill") await stop();
        else throw new Error("Unsupported macOS signal");
      },
      terminate: stop,
    };
    return { process: managed, enforcement: {
      sandboxBackend: "traceforge-macos-native", backendMeasurement: this.helper.sha256,
      sandboxed: true, filesystemPolicyApplied: true, permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
      resourceLimitsApplied: false, resourcePolicy: "sampled_terminate", resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources),
      network: request.permissions.network, atomicProcessTreeAssignment: true, processTreeEmptyBarrier: true,
    } };
  }
}
