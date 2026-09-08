import type { Writable } from "node:stream";
import { constants } from "node:os";
import type { ManagedProcess, ProcessLauncher, LaunchedProcess } from "./runtime.js";
import { permissionProfileFingerprint, resourceLimitsFingerprint, type StartProcessRequest, type ProcessSignal, type ResourceLimitKind } from "./protocol.js";
import { runMacosOwnedExecution } from "./macos-owned-execution.js";
import { writeProcessPipe } from "./process-watchdog.js";
import type { MacosSystemServicePolicy } from "./macos-seatbelt.js";

/** Local owned-group transport; only a confirmed empty-group terminal emits exit. */
export class MacosProcessLauncher implements ProcessLauncher {
  private readonly services: MacosSystemServicePolicy | undefined;
  /** Host-owned dedicated launcher policy, never a task/RPC argument. */
  constructor(private readonly helper: { path: string; sha256: string }, services?: MacosSystemServicePolicy) {
    this.services = services ? structuredClone(services) : undefined;
  }
  async launch(request: StartProcessRequest): Promise<LaunchedProcess> {
    const abort = new AbortController();
    let input: Writable | null = null;
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
      ready(pid, stream) { input = stream; resolveReady(pid); },
      output(stream, bytes) {
        if (outputListener) outputListener(stream, bytes);
        else if (bufferedBytes < request.outputLimitBytes) {
          const retained = Buffer.from(bytes.subarray(0, request.outputLimitBytes - bufferedBytes));
          outputs.push([stream, retained]); bufferedBytes += retained.length;
        }
      },
      resourceLimit(resource) { limit = resource; resourceListener?.(resource); },
    }, this.services).then(result => {
      if (!result.cleanupConfirmed) { fail(new Error("macOS process-group cleanup is unconfirmed")); return; }
      if (result.reason === "supervision_failed") { fail(new Error("macOS process supervision failed")); return; }
      const name = Object.entries(constants.signals).find(([, value]) => value === result.signal)?.[0] ?? null;
      exit = [result.exitCode, name]; for (const listener of exitListeners) listener(...exit);
      rejectReady(new Error("macOS supervisor exited before readiness"));
    }, error => fail(error instanceof Error ? error : new Error(String(error))));
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
      async resizeTerminal() { throw new Error("macOS PTY is not supported"); },
      async sendSignal(signal: ProcessSignal) { if (signal === "interrupt") throw new Error("macOS interrupt is not supported"); await stop(); },
      terminate: stop,
    };
    return { process: managed, enforcement: {
      sandboxBackend: "traceforge-macos-native", backendMeasurement: this.helper.sha256,
      sandboxed: true, filesystemPolicyApplied: true, permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
      resourceLimitsApplied: false, resourcePolicy: "sampled_terminate", resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources),
      network: "deny", atomicProcessTreeAssignment: true, processTreeEmptyBarrier: true,
    } };
  }
}
