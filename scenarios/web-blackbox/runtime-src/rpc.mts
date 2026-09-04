import { PROTOCOL_VERSION, type CapabilityReceipt, type JsonObject } from "./contracts.mjs";

export class ScenarioRpcHost {
  private sequence = 0;
  private readonly pending = new Map<string, { resolve(value: CapabilityReceipt): void; reject(error: Error): void }>();

  send(value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    process.stdout.write(frame);
  }

  fail(id: string, error: unknown): void {
    this.send({ version: PROTOCOL_VERSION, id, ok: false, error: {
      code: "scenario_error", message: error instanceof Error ? error.message : "Scenario operation failed", retryable: false,
    } });
  }

  capability(parentRequestId: string, context: JsonObject, capability: string, action: string, input: unknown, suffix: string): Promise<CapabilityReceipt> {
    const id = `host:${parentRequestId}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ version: PROTOCOL_VERSION, id, method: "host.capability.call", params: {
        parentRequestId, capability, action, idempotencyKey: `${suffix}:${context.idempotencyKey}`, input,
      } });
    });
  }

  acceptResponse(message: JsonObject): boolean {
    if (typeof message.ok !== "boolean") return false;
    const pending = this.pending.get(String(message.id));
    if (!pending) return true;
    this.pending.delete(String(message.id));
    if (message.ok) pending.resolve(message.result as CapabilityReceipt);
    else pending.reject(new Error(message.error?.message ?? "Host capability failed"));
    return true;
  }
}
