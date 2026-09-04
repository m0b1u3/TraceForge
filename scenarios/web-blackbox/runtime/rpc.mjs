import { PROTOCOL_VERSION } from "./contracts.mjs";
export class ScenarioRpcHost {
    sequence = 0;
    pending = new Map();
    send(value) {
        const payload = Buffer.from(JSON.stringify(value), "utf8");
        const frame = Buffer.allocUnsafe(payload.length + 4);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);
        process.stdout.write(frame);
    }
    fail(id, error) {
        this.send({ version: PROTOCOL_VERSION, id, ok: false, error: {
                code: "scenario_error", message: error instanceof Error ? error.message : "Scenario operation failed", retryable: false,
            } });
    }
    capability(parentRequestId, context, capability, action, input, suffix) {
        const id = `host:${parentRequestId}:${++this.sequence}`;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.send({ version: PROTOCOL_VERSION, id, method: "host.capability.call", params: {
                    parentRequestId, capability, action, idempotencyKey: `${suffix}:${context.idempotencyKey}`, input,
                } });
        });
    }
    acceptResponse(message) {
        if (typeof message.ok !== "boolean")
            return false;
        const pending = this.pending.get(String(message.id));
        if (!pending)
            return true;
        this.pending.delete(String(message.id));
        if (message.ok)
            pending.resolve(message.result);
        else
            pending.reject(new Error(message.error?.message ?? "Host capability failed"));
        return true;
    }
}
