const protocolVersion = 1;
let buffered = Buffer.alloc(0);
const parents = new Map();

function send(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4); frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4);
  process.stdout.write(frame);
}

function handle(request) {
  if (request.version !== protocolVersion) return process.exit(2);
  if (typeof request.ok === "boolean") {
    const parent = parents.get(request.id); if (!parent) return;
    parents.delete(request.id);
    return send({ version: protocolVersion, id: parent, ok: true, result: {
      status: "succeeded", summary: "Scenario capability completed", raw: JSON.stringify(request.result ?? request.error),
      refs: request.result?.refs ?? [], retryable: false,
    } });
  }
  if (request.method === "provider.handshake") return send({ version: protocolVersion, id: request.id, ok: true, result: {
    providerId: "fixture.process-package", providerVersion: "1.0.0", protocolVersion,
    profile: "traceforge-scenario-process-rpc",
  } });
  if (request.method === "tools.list") return send({ version: protocolVersion, id: request.id, ok: true, result: [{
    name: "fixture.observe", source: "scenario:fixture.process-package", version: "1.0.0", priority: 1,
    description: "Read package-scoped state", inputSchema: { type: "object" }, providedCapabilities: ["fixture.observe"],
    dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000,
  }] });
  if (request.method === "tools.call") {
    const reverse = `reverse:${request.id}`; parents.set(reverse, request.id);
    return send({ version: protocolVersion, id: reverse, method: "host.capability.call", params: {
      parentRequestId: request.id, capability: "traceforge.scenario.state@1", action: "read",
      idempotencyKey: `state:${request.params.context.idempotencyKey}`, input: { operation: "read", key: "cursor" },
    } });
  }
  send({ version: protocolVersion, id: request.id, ok: false, error: { code: "method_not_found", message: "Unknown method", retryable: false } });
}

process.stdin.on("data", (chunk) => {
  buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0); if (buffered.length < length + 4) break;
    const value = JSON.parse(buffered.subarray(4, length + 4).toString("utf8")); buffered = buffered.subarray(length + 4); handle(value);
  }
});
process.stdin.on("end", () => process.exit(0));
