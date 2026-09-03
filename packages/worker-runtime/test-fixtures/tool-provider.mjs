const version = 1;
let buffered = Buffer.alloc(0);
const capabilityParents = new Map();

function send(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  process.stdout.write(frame);
}

function respond(request) {
  if (request.version !== version) return process.exit(2);
  if (typeof request.ok === "boolean") {
    const parent = capabilityParents.get(request.id);
    if (!parent) return;
    capabilityParents.delete(request.id);
    const status = request.ok ? request.result?.status ?? "unknown" : request.error?.code ?? "error";
    return send({ version, id: parent, ok: true, result: {
      status: "succeeded", summary: `fixture host capability ${status}`, raw: JSON.stringify(request.result ?? request.error ?? null),
      refs: [`host:${status}`], retryable: false,
    } });
  }
  if (request.method === "provider.handshake") {
    return send({ version, id: request.id, ok: true, result: {
      providerId: process.env.TRACEFORGE_TEST_PROVIDER_ID ?? "fixture",
      providerVersion: process.env.TRACEFORGE_TEST_PROVIDER_VERSION ?? "1.0.0",
      protocolVersion: version,
      ...(process.env.TRACEFORGE_TEST_PROTOCOL_PROFILE ? { profile: process.env.TRACEFORGE_TEST_PROTOCOL_PROFILE } : {}),
    } });
  }
  if (request.method === "tools.list") {
    if (process.env.TRACEFORGE_TEST_PROTOCOL_CORRUPT === "true") {
      const invalid = Buffer.alloc(4); invalid.writeUInt32BE(0); process.stdout.write(invalid); return;
    }
    if (process.env.TRACEFORGE_TEST_INVALID_CATALOG === "true") return send({ version, id: request.id, ok: true, result: [{ invalid: true }] });
    return send({ version, id: request.id, ok: true, result: [{
      name: "fixture.read", source: process.env.TRACEFORGE_TEST_SOURCE ?? "rpc:test",
      version: process.env.TRACEFORGE_TEST_PROVIDER_VERSION ?? "1.0.0", priority: 100,
      description: process.env.TRACEFORGE_TEST_OBSERVATION ? "Read the current observation token. Invoke with an empty object." : "Read fixture input",
      inputSchema: { type: "object", ...(process.env.TRACEFORGE_TEST_OBSERVATION ? { additionalProperties: false } : {}) },
      providedCapabilities: (process.env.TRACEFORGE_TEST_CAPABILITIES ?? "fixture.read").split(",").filter(Boolean),
      dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000,
    }] });
  }
  if (request.method === "tools.call") {
    if (process.env.TRACEFORGE_TEST_OBSERVATION) {
      return send({ version, id: request.id, ok: true, result: {
        status: "succeeded", summary: `Observation token: ${process.env.TRACEFORGE_TEST_OBSERVATION}`,
        raw: JSON.stringify({ observationToken: process.env.TRACEFORGE_TEST_OBSERVATION }),
        refs: [`work:${request.params?.context?.workId ?? "unknown"}`], retryable: false,
      } });
    }
    if (request.params?.input?.crashDetail === true) {
      process.stderr.write("sensitive-stderr-detail-".repeat(2_000));
      return setImmediate(() => process.exit(9));
    }
    if (request.params?.input?.crash === true) return process.exit(9);
    if (Number.isInteger(request.params?.input?.delayMs) && request.params.input.delayMs > 0) {
      return setTimeout(() => send({ version, id: request.id, ok: true, result: {
        status: "succeeded", summary: "fixture completed after delay", raw: "", refs: [], retryable: false,
      } }), request.params.input.delayMs);
    }
    if (request.params?.input?.broker === true || request.params?.input?.unknownParent === true) {
      const reverseId = `reverse:${request.id}`;
      capabilityParents.set(reverseId, request.id);
      return send({
        version,
        id: reverseId,
        method: "host.capability.call",
        params: {
          parentRequestId: request.params.input.unknownParent === true ? "missing-parent" : request.id,
          capability: process.env.TRACEFORGE_TEST_HOST_CAPABILITY ?? "fixture.lookup",
          action: process.env.TRACEFORGE_TEST_HOST_ACTION ?? "fixture.inspect",
          idempotencyKey: `fixture:${request.params.context?.idempotencyKey ?? request.id}`,
          input: { subject: "first candidate" },
        },
      });
    }
    return send({ version, id: request.id, ok: true, result: {
      status: "succeeded", summary: "fixture completed", raw: JSON.stringify(request.params?.input ?? null),
      refs: [`work:${request.params?.context?.workId ?? "unknown"}`], retryable: false,
    } });
  }
  send({ version, id: request.id, ok: false, error: { code: "method_not_found", message: "Unknown method", retryable: false } });
}

process.stdin.on("data", (chunk) => {
  buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < length + 4) break;
    const value = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
    buffered = buffered.subarray(length + 4);
    respond(value);
  }
});
